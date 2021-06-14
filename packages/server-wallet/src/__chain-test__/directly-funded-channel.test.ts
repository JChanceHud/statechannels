import path from 'path';

import {CreateChannelParams, Participant, Allocation} from '@statechannels/client-api-schema';
import {TEST_ACCOUNTS} from '@statechannels/devtools';
import {ContractArtifacts} from '@statechannels/nitro-protocol';
import {BN, makeAddress, makeDestination} from '@statechannels/wallet-core';
import {BigNumber, BigNumberish, Contract, providers, utils} from 'ethers';
import _ from 'lodash';
import {hexZeroPad} from '@ethersproject/bytes';

import {ChainService} from '../chain-service';
import {defaultTestConfig, overwriteConfigWithDatabaseConnection, EngineConfig} from '../config';
import {DBAdmin} from '../db-admin/db-admin';
import {Engine} from '../engine';
import {LatencyOptions, TestMessageService} from '../message-service/test-message-service';
import {SyncOptions, Wallet} from '../wallet';
import {ONE_DAY} from '../__test__/test-helpers';
import {waitForObjectiveProposals} from '../__test-with-peers__/utils';
import {ARTIFACTS_DIR} from '../../jest/chain-setup';
import {COUNTING_APP_DEFINITION} from '../models/__test__/fixtures/app-bytecode';

jest.setTimeout(60_000);

// eslint-disable-next-line no-process-env, @typescript-eslint/no-non-null-assertion
const ethAssetHolderAddress = makeAddress(process.env.ETH_ASSET_HOLDER_ADDRESS!);
// eslint-disable-next-line no-process-env, @typescript-eslint/no-non-null-assertion
if (!process.env.RPC_ENDPOINT) throw new Error('RPC_ENDPOINT must be defined');
// eslint-disable-next-line no-process-env, @typescript-eslint/no-non-null-assertion
const rpcEndpoint = process.env.RPC_ENDPOINT;

const config = {
  ...defaultTestConfig(),
  networkConfiguration: {
    ...defaultTestConfig().networkConfiguration,
    // eslint-disable-next-line no-process-env
    chainNetworkID: parseInt(process.env.CHAIN_NETWORK_ID || '0'),
  },
};

let provider: providers.JsonRpcProvider;
let a: Wallet;
let b: Wallet;
let aEngine: Engine;
let bEngine: Engine;
let participantA: Participant;
let participantB: Participant;

const bEngineConfig: EngineConfig = {
  ...overwriteConfigWithDatabaseConnection(config, {database: 'server_wallet_test_b'}),
  loggingConfiguration: {
    logDestination: path.join(ARTIFACTS_DIR, 'direct-funding.log'),
    logLevel: 'trace',
  },
  chainServiceConfiguration: {
    attachChainService: true,
    provider: rpcEndpoint,
    /* eslint-disable-next-line no-process-env */
    pk: process.env.CHAIN_SERVICE_PK ?? TEST_ACCOUNTS[1].privateKey,
    allowanceMode: 'MaxUint',
  },
};
const aEngineConfig: EngineConfig = {
  ...overwriteConfigWithDatabaseConnection(config, {database: 'server_wallet_test_a'}),
  loggingConfiguration: {
    logDestination: path.join(ARTIFACTS_DIR, 'direct-funding.log'),
    logLevel: 'trace',
  },
  chainServiceConfiguration: {
    attachChainService: true,
    provider: rpcEndpoint,
    /* eslint-disable-next-line no-process-env */
    pk: process.env.CHAIN_SERVICE_PK2 ?? TEST_ACCOUNTS[2].privateKey,
    allowanceMode: 'MaxUint',
  },
};

const aAddress = '0x50Bcf60D1d63B7DD3DAF6331a688749dCBD65d96';
const bAddress = '0x632d0b05c78A83cEd439D3bd6C710c4814D3a6db';

async function getBalance(address: string): Promise<BigNumber> {
  return await provider.getBalance(address);
}

async function mineBlocks(confirmations = 5) {
  for (const _i in _.range(confirmations)) {
    await provider.send('evm_mine', []);
  }
}

const mineBlocksForEvent = () => mineBlocks();

function mineOnEvent(contract: Contract) {
  contract.on('Deposited', mineBlocksForEvent);
  contract.on('AllocationUpdated', mineBlocksForEvent);
}

beforeAll(async () => {
  provider = new providers.JsonRpcProvider(rpcEndpoint);

  await Promise.all(
    [aEngineConfig, bEngineConfig].map(async config => {
      await DBAdmin.dropDatabase(config);
      await DBAdmin.createDatabase(config);
      await DBAdmin.migrateDatabase(config);
    })
  );

  aEngine = await Engine.create(aEngineConfig);
  bEngine = await Engine.create(bEngineConfig);
  participantA = {
    signingAddress: await aEngine.getSigningAddress(),
    participantId: 'a',
    destination: makeDestination(aAddress),
  };
  participantB = {
    signingAddress: await bEngine.getSigningAddress(),
    participantId: 'b',
    destination: makeDestination(bAddress),
  };
  const aChainService = new ChainService({
    ...aEngineConfig.chainServiceConfiguration,
    logger: aEngine.logger,
  });
  const bChainService = new ChainService({
    ...bEngineConfig.chainServiceConfiguration,
    logger: bEngine.logger,
  });

  const syncOptions: SyncOptions = {
    pollInterval: 1_000,
    timeOutThreshold: 60_000,
    staleThreshold: 10_000,
  };
  a = await Wallet.create(aEngine, aChainService, TestMessageService.create, syncOptions);
  b = await Wallet.create(bEngine, bChainService, TestMessageService.create, syncOptions);

  TestMessageService.linkMessageServices(a.messageService, b.messageService, aEngine.logger);
  const assetHolder = new Contract(
    ethAssetHolderAddress,
    ContractArtifacts.EthAssetHolderArtifact.abi,
    provider
  );
  mineOnEvent(assetHolder);
});

afterAll(async () => {
  await Promise.all([a.destroy(), b.destroy()]);
  await Promise.all([DBAdmin.dropDatabase(aEngineConfig), DBAdmin.dropDatabase(bEngineConfig)]);
  provider.polling = false;
  provider.removeAllListeners();
});

const testCases: Array<LatencyOptions & {closer: 'A' | 'B'}> = [
  {
    dropRate: 0,
    meanDelay: undefined,
    closer: 'A',
  },
  {
    dropRate: 0,
    meanDelay: undefined,
    closer: 'B',
  },
  {dropRate: 0.1, meanDelay: 50, closer: 'A'},
  {dropRate: 0.1, meanDelay: 50, closer: 'B'},
];
test.each(testCases)(
  `can successfully fund and defund a channel between two wallets with options %o`,
  async options => {
    TestMessageService.setLatencyOptions({a, b}, options);

    const channelParams: CreateChannelParams = {
      participants: [participantA, participantB],
      allocations: [createAllocation(3, 2)],
      appDefinition: COUNTING_APP_DEFINITION,
      appData: utils.defaultAbiCoder.encode(['uint256'], [1]),
      fundingStrategy: 'Direct',
      challengeDuration: ONE_DAY,
    };
    const aBalanceInit = await getBalance(aAddress);
    const bBalanceInit = await getBalance(bAddress);
    const assetHolderBalanceInit = await getBalance(ethAssetHolderAddress);

    const response = await a.createChannels([channelParams]);
    await waitForObjectiveProposals([response[0].objectiveId], b);
    const bResponse = await b.approveObjectives([response[0].objectiveId]);

    await expect(response).toBeObjectiveDoneType('Success');
    await expect(bResponse).toBeObjectiveDoneType('Success');

    const assetHolderBalanceUpdated = await getBalance(ethAssetHolderAddress);
    expect(BN.sub(assetHolderBalanceUpdated, assetHolderBalanceInit)).toEqual(BN.add(2, 3));

    const {channelId} = response[0];
    const updated = await a.updateChannel(
      channelId,
      [createAllocation(1, 4)],
      utils.defaultAbiCoder.encode(['uint256'], [2])
    );

    expect(updated).toMatchObject({
      type: 'Success',
      result: {
        turnNum: 4,
        allocations: [createAllocation(1, 4)],
      },
    });

    const closeResponse =
      options.closer === 'A'
        ? await a.closeChannels([channelId])
        : await b.closeChannels([channelId]);
    await expect(closeResponse).toBeObjectiveDoneType('Success');

    const aBalanceFinal = await getBalance(aAddress);
    const bBalanceFinal = await getBalance(bAddress);

    expect(BN.sub(aBalanceFinal, aBalanceInit)).toEqual(BN.from(1));
    expect(BN.sub(bBalanceFinal, bBalanceInit)).toEqual(BN.from(4));
  }
);

const createAllocation = (aAmount: BigNumberish, bAmount: BigNumberish): Allocation => ({
  allocationItems: [
    {
      destination: participantA.destination,
      amount: hexZeroPad(BigNumber.from(aAmount).toHexString(), 32),
    },
    {
      destination: participantB.destination,
      amount: hexZeroPad(BigNumber.from(bAmount).toHexString(), 32),
    },
  ],
  assetHolderAddress: ethAssetHolderAddress,
});
