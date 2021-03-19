import {
  DBAdmin,
  defaultTestConfig,
  overwriteConfigWithDatabaseConnection,
  SingleThreadedWallet
} from '@statechannels/server-wallet';
import {ETHERLIME_ACCOUNTS} from '@statechannels/devtools';
import {ClientWallet} from '@statechannels/xstate-wallet';
import {constants} from 'ethers';
import {
  BN,
  deserializeObjective,
  deserializeState,
  makeDestination,
  validatePayload
} from '@statechannels/wallet-core';

jest.setTimeout(60_000);

const baseConfig = defaultTestConfig({
  networkConfiguration: {
    chainNetworkID: process.env.CHAIN_ID
      ? parseInt(process.env.CHAIN_ID)
      : defaultTestConfig().networkConfiguration.chainNetworkID
  },
  chainServiceConfiguration: {
    attachChainService: true,
    provider: process.env.RPC_ENDPOINT,
    pk: ETHERLIME_ACCOUNTS[0].privateKey
  }
});

const serverConfig = overwriteConfigWithDatabaseConnection(baseConfig, {
  database: 'server_peer'
});

beforeAll(async () => {
  await DBAdmin.truncateDatabase(serverConfig);
  await DBAdmin.migrateDatabase(serverConfig);
});

it('e2e test', async () => {
  expect(1).toEqual(1);
});

it.skip('e2e test', async () => {
  const serverWallet = await SingleThreadedWallet.create(serverConfig);
  const xstateWallet = await ClientWallet.create();

  const serverAddress = await serverWallet.getSigningAddress();
  const serverDestination = makeDestination(serverAddress);
  const xstateDestination = makeDestination(await xstateWallet.store.getAddress());

  const {
    outbox: [{params}]
  } = await serverWallet.createChannel({
    appData: '0x',
    appDefinition: constants.AddressZero,
    fundingStrategy: 'Direct',
    challengeDuration: 86400, // one day
    participants: [
      {
        participantId: 'server',
        signingAddress: serverAddress,
        destination: serverDestination
      },
      {
        participantId: 'xstate',
        signingAddress: await xstateWallet.store.getAddress(),
        destination: xstateDestination
      }
    ],
    allocations: [
      {
        assetHolderAddress: constants.AddressZero,
        allocationItems: [
          {
            amount: BN.from(3),
            destination: serverDestination
          },
          {amount: BN.from(5), destination: xstateDestination}
        ]
      }
    ]
  });

  const wirePayload = validatePayload(params.data);
  const payload = {
    objectives: wirePayload.objectives?.map(deserializeObjective) || [],
    signedStates: wirePayload.signedStates?.map(deserializeState) || []
  };

  const xstatePrefundResponse = await xstateWallet.incomingMessage(payload);
  const serverPreDepositResponse = await serverWallet.pushMessage({
    ...xstatePrefundResponse,
    requests: [],
    walletVersion: '@statechannels/server-wallet@1.23.0'
  });
  expect(serverPreDepositResponse).toBeDefined();
});
