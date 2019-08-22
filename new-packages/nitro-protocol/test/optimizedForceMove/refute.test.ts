import {ethers} from 'ethers';
import {expectRevert} from 'magmo-devtools';
// @ts-ignore
import optimizedForceMoveArtifact from '../../build/contracts/TESTOptimizedForceMove.json';
// @ts-ignore
import countingAppArtifact from '../../build/contracts/CountingApp.json';
import {keccak256, defaultAbiCoder} from 'ethers/utils';
import {setupContracts, sign} from './test-helpers';
import {HashZero, AddressZero} from 'ethers/constants';

const provider = new ethers.providers.JsonRpcProvider(
  `http://localhost:${process.env.DEV_GANACHE_PORT}`,
);
let optimizedForceMove: ethers.Contract;
let networkId;
const chainId = 1234;
const participants = ['', '', ''];
const wallets = new Array(3);
const challengeDuration = 1000;
const outcome = ethers.utils.id('some outcome data'); // use a fixed outcome for all state updates in all tests
const outcomeHash = keccak256(defaultAbiCoder.encode(['bytes'], [outcome]));
let appDefinition;

// populate wallets and participants array
for (let i = 0; i < 3; i++) {
  wallets[i] = ethers.Wallet.createRandom();
  participants[i] = wallets[i].address;
}
const nonParticipant = ethers.Wallet.createRandom();

beforeAll(async () => {
  optimizedForceMove = await setupContracts(provider, optimizedForceMoveArtifact);
  networkId = (await provider.getNetwork()).chainId;
  appDefinition = countingAppArtifact.networks[networkId].address; // use a fixed appDefinition in all tests
});

// Scenarios are synonymous with channelNonce:

const description1 = 'It accepts a refute tx for an ongoing challenge';
const description2 = 'It reverts a regute tx if the challenge has expired';
const description3 = 'It reverts a refute tx if the declaredTurnNumRecord is incorrect';
const description4 =
  'It reverts a refute tx if the refutation state is not signed by the challenger';
const description5 =
  'It reverts a refute tx if the refutationTurnNum is not larger than declaredTurnNumRecord'; // TODO

describe('respond', () => {
  it.each`
    description     | channelNonce | setTurnNumRecord | declaredTurnNumRecord | refutationTurnNum | expired  | isFinalAB         | appDatas  | challenger    | refutationStateSigner | reasonString
    ${description1} | ${1001}      | ${8}             | ${8}                  | ${99}             | ${false} | ${[false, false]} | ${[0, 1]} | ${wallets[2]} | ${wallets[2]}         | ${undefined}
    ${description2} | ${1002}      | ${8}             | ${8}                  | ${99}             | ${true}  | ${[false, false]} | ${[0, 1]} | ${wallets[2]} | ${wallets[2]}         | ${'Refute too late!'}
    ${description3} | ${1003}      | ${8}             | ${7}                  | ${99}             | ${false} | ${[false, false]} | ${[0, 1]} | ${wallets[2]} | ${wallets[2]}         | ${'Challenge State does not match stored version'}
    ${description4} | ${1004}      | ${8}             | ${8}                  | ${99}             | ${false} | ${[false, false]} | ${[0, 1]} | ${wallets[2]} | ${nonParticipant}     | ${'Refutation state not signed by challenger'}
  `(
    '$description', // for the purposes of this test, chainId and participants are fixed, making channelId 1-1 with channelNonce
    async ({
      channelNonce,
      setTurnNumRecord,
      declaredTurnNumRecord,
      refutationTurnNum,
      expired,
      isFinalAB,
      appDatas,
      challenger,
      refutationStateSigner,
      reasonString,
    }) => {
      // compute channelId
      const channelId = keccak256(
        defaultAbiCoder.encode(
          ['uint256', 'address[]', 'uint256'],
          [chainId, participants, channelNonce],
        ),
      );
      // fixedPart
      const fixedPart = {
        chainId,
        participants,
        channelNonce,
        appDefinition,
        challengeDuration,
      };

      const challengeAppPartHash = keccak256(
        defaultAbiCoder.encode(
          ['uint256', 'address', 'bytes'],
          [challengeDuration, appDefinition, defaultAbiCoder.encode(['uint256'], [appDatas[0]])],
        ),
      );

      const challengeState = {
        turnNum: setTurnNumRecord,
        isFinal: isFinalAB[0],
        channelId,
        challengeAppPartHash,
        outcomeHash,
      };

      const challengeStateHash = keccak256(
        defaultAbiCoder.encode(
          [
            'tuple(uint256 turnNum, bool isFinal, bytes32 channelId, bytes32 challengeAppPartHash, bytes32 outcomeHash)',
          ],
          [challengeState],
        ),
      );

      const refutationAppPartHash = keccak256(
        defaultAbiCoder.encode(
          ['uint256', 'address', 'bytes'],
          [challengeDuration, appDefinition, defaultAbiCoder.encode(['uint256'], [appDatas[1]])],
        ),
      );

      const refutationState = {
        turnNum: refutationTurnNum,
        isFinal: isFinalAB[1],
        channelId,
        refutationAppPartHash,
        outcomeHash,
      };

      const refutationStateHash = keccak256(
        defaultAbiCoder.encode(
          [
            'tuple(uint256 turnNum, bool isFinal, bytes32 channelId, bytes32 refutationAppPartHash, bytes32 outcomeHash)',
          ],
          [refutationState],
        ),
      );

      const challengeVariablePart = {
        outcome,
        appData: defaultAbiCoder.encode(['uint256'], [appDatas[0]]), // a counter
      };
      const refutationVariablePart = {
        outcome,
        appData: defaultAbiCoder.encode(['uint256'], [appDatas[1]]), // a counter
      };

      // set expiry time in the future or in the past
      const blockNumber = await provider.getBlockNumber();
      const blockTimestamp = (await provider.getBlock(blockNumber)).timestamp;
      const expiryTime = expired
        ? blockTimestamp - challengeDuration
        : blockTimestamp + challengeDuration;

      // compute expected ChannelStorageHash
      const challengeExistsHash = keccak256(
        defaultAbiCoder.encode(
          ['uint256', 'uint256', 'bytes32', 'address', 'bytes32'],
          [setTurnNumRecord, expiryTime, challengeStateHash, challenger.address, outcomeHash],
        ),
      );

      // call public wrapper to set state (only works on test contract)
      const tx = await optimizedForceMove.setChannelStorageHash(channelId, challengeExistsHash);
      await tx.wait();
      expect(await optimizedForceMove.channelStorageHashes(channelId)).toEqual(challengeExistsHash);

      // sign the state
      const signature = await sign(refutationStateSigner, refutationStateHash);
      const refutationStateSig = {v: signature.v, r: signature.r, s: signature.s};

      if (reasonString) {
        expectRevert(
          () =>
            optimizedForceMove.refute(
              declaredTurnNumRecord,
              refutationTurnNum,
              expiryTime,
              challenger.address,
              isFinalAB,
              fixedPart,
              [challengeVariablePart, refutationVariablePart],
              refutationStateSig,
            ),
          'VM Exception while processing transaction: revert ' + reasonString,
        );
      } else {
        // call respond
        const tx2 = await optimizedForceMove.refute(
          declaredTurnNumRecord,
          refutationTurnNum,
          expiryTime,
          challenger.address,
          isFinalAB,
          fixedPart,
          [challengeVariablePart, refutationVariablePart],
          refutationStateSig,
        );

        await tx2.wait();

        // compute and check new expected ChannelStorageHash
        const expectedChannelStorage = [declaredTurnNumRecord, 0, HashZero, AddressZero, HashZero];
        const expectedChannelStorageHash = keccak256(
          defaultAbiCoder.encode(
            ['uint256', 'uint256', 'bytes32', 'address', 'bytes32'],
            expectedChannelStorage,
          ),
        );
        expect(await optimizedForceMove.channelStorageHashes(channelId)).toEqual(
          expectedChannelStorageHash,
        );
      }
    },
  );
});
