import {ChannelResult} from '@statechannels/client-api-schema';

import {channelWithVars} from '../../models/__test__/fixtures/channel';
import {Notice} from '../../protocols/actions';
import {addHash} from '../../state-utils';
import {stateSignedBy} from '../../wallet/__test__/fixtures/states';
import {mergeChannelResults, mergeOutgoing} from '../messaging';

describe('mergeChannelResults', () => {
  test('it merges channel results with multiple channel id entries', () => {
    const duplicateChannelResult: ChannelResult[] = [
      channelWithVars({vars: [addHash(stateSignedBy()({turnNum: 1}))]}).channelResult,
      channelWithVars({vars: [addHash(stateSignedBy()({turnNum: 2}))]}).channelResult,
    ];
    const result = mergeChannelResults(duplicateChannelResult);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({turnNum: 2});
  });

  test("it doesn't merge different channels", () => {
    const duplicateChannelResult: ChannelResult[] = [
      channelWithVars({channelId: '0x123'}).channelResult,
      channelWithVars({channelId: '0xabc'}).channelResult,
    ];

    const result = mergeChannelResults(duplicateChannelResult);
    expect(result).toHaveLength(2);
  });
});

describe('mergeOutgoing', () => {
  const USER1 = 'Recipient1';
  const USER2 = 'Recipient2';

  test('it merges two messages with the same recipient', () => {
    const state1 = stateSignedBy()({turnNum: 1});
    const state2 = stateSignedBy()({turnNum: 2});

    const message1: Notice = {
      method: 'MessageQueued',
      params: {recipient: USER1, sender: USER2, data: {signedStates: [state1]}},
    };
    const message2: Notice = {
      method: 'MessageQueued',
      params: {recipient: USER1, sender: USER2, data: {signedStates: [state2]}},
    };

    const merged = mergeOutgoing([message1, message2]);
    expect(merged).toHaveLength(1);

    expect((merged[0] as any).params.data.signedStates).toHaveLength(2);
  });

  test('it handles duplicate states', () => {
    // We use two seperate state objects that are equivalent to avoid things passing
    // due to object references being the same
    const state1 = stateSignedBy()({turnNum: 1});
    const state2 = stateSignedBy()({turnNum: 1});
    const message1: Notice = {
      method: 'MessageQueued',
      params: {recipient: USER1, sender: USER2, data: {signedStates: [state1]}},
    };
    const message2: Notice = {
      method: 'MessageQueued',
      params: {recipient: USER1, sender: USER2, data: {signedStates: [state2]}},
    };

    const merged = mergeOutgoing([message1, message2]);
    expect(merged).toHaveLength(1);

    expect((merged[0] as any).params.data.signedStates).toHaveLength(1);
  });
});
