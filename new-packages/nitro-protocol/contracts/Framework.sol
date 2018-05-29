pragma solidity ^0.4.23;

import "./CommonState.sol";
import "./ForceMoveGame.sol";

library Framework {
    using CommonState for bytes;

    struct Challenge {
        bytes32 channelId;
        bytes state;
        uint256[2] resolvedBalances;
        uint32 expirationTime;
    }

    function validForceMove(
        bytes _yourState,
        bytes _myState,
        uint8[] v,
        bytes32[] r,
        bytes32[] s
    ) public pure returns (bool) {
        // states must be signed by the appropriate participant
        _yourState.requireSignature(v[0], r[0], s[0]);
        _myState.requireSignature(v[1], r[1], s[1]);

        return validTransition(_yourState, _myState);
    }

    function validConclusionProof(
        bytes _yourState,
        bytes _myState,
        uint8[] v,
        bytes32[] r,
        bytes32[] s
    ) public pure returns (bool) {
        // states must be signed by the appropriate participant
        _yourState.requireSignature(v[0], r[0], s[0]);
        _myState.requireSignature(v[1], r[1], s[1]);

        // first move must be a concluded state (transition rules will ensure this for the other states)
        require(ForceMoveGame(_yourState.channelType()).isConcluded(_yourState));
        // must be a valid transition
        return validTransition(_yourState, _myState);
    }

    function validRefute(
        bytes _challengeState,
        bytes _refutationState,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public pure returns (bool) {
        // the refutationState must have a higher nonce
        require(_refutationState.turnNum() > _challengeState.turnNum());
        // ... with the same mover
        require(_refutationState.mover() == _challengeState.mover());
        // ... and be signed (by that mover)
        _refutationState.requireSignature(v, r, s);

        return true;
    }

    function validRespondWithMove(
        bytes _challengeState,
        bytes _nextState,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) public pure returns (bool) {
        // check that the challengee's signature matches
        _nextState.requireSignature(v, r, s);

        require(validTransition(_challengeState, _nextState));

        return true;
    }

    function validAlternativeRespondWithMove(
        bytes _challengeState,
        bytes _alternativeState,
        bytes _nextState,
        uint8[] v,
        bytes32[] r,
        bytes32[] s
    ) public pure returns (bool) {

        // checking the alternative state:
        // .. it must have the right channel
        require(_challengeState.channelId() == _alternativeState.channelId());
        // .. it must have the same nonce as the challenge state
        require(_challengeState.turnNum() == _alternativeState.turnNum());
        // .. it must be signed (by the challenger)
        _alternativeState.requireSignature(v[0], r[0], s[0]);

        // checking the nextState:
        // .. it must be signed (my the challengee)
        _nextState.requireSignature(v[1], r[1], s[1]);
        // .. it must be a valid transition of the gamestate (from the alternative state)
        require(validTransition(_alternativeState, _nextState));

        return true;
    }

    function validTransition(bytes _fromState, bytes _toState) public pure returns (bool) {
        require(_toState.channelId() == _fromState.channelId());
        require(_toState.turnNum() == _fromState.turnNum() + 1);

        if (_fromState.stateType() == CommonState.StateType.Propose) {
            return validTransitionFromPropose(_fromState, _toState);
        } else if (_fromState.stateType() == CommonState.StateType.Accept) {
            return validTransitionFromAccept(_fromState, _toState);
        } else if (_fromState.stateType() == CommonState.StateType.Game) {
            return validTransitionFromGame(_fromState, _toState);
        } else if (_fromState.stateType() == CommonState.StateType.Conclude) {
            return validTransitionFromConclude(_fromState, _toState);
        }

        return true;
    }

    function validTransitionFromPropose(bytes _fromState, bytes _toState) public pure returns (bool) {
        if (_fromState.stateCount() == _fromState.numberOfParticipants()) {
            // if we're in the final Propose state there are two options:
            // 1. Propose -> Accept transition
            // 2. Propose -> Conclude transition
            if (_toState.stateType() == CommonState.StateType.Accept) {
                require(_toState.stateCount() == 0); // reset the stateCount
                /* require(_toState.position() == _fromState.position()); */
                /* require(_toState.balances() == _fromState.balances(); */
            } else {
                require(_toState.stateType() == CommonState.StateType.Conclude);
                /* require(_toState.balances() == _fromState.balances(); */
            }
        } else {
            // Propose -> Propose transition
            require(_toState.stateType() == CommonState.StateType.Propose);
            /* require(_toState.position() == _fromState.position()); */
            require(_toState.stateCount() == _fromState.stateCount() + 1);
            /* require(_toState.balances() == _fromState.balances(); */
        }
        return true;
    }

    function validTransitionFromAccept(bytes _fromState, bytes _toState) public pure returns (bool) {
        if (_fromState.stateCount() == _fromState.numberOfParticipants()) {
            // Accept -> Game transition is the only option
            require(_toState.stateType() == CommonState.StateType.Game);
            /* require(_toState.position() == _fromState.position()); */
            /* ForceMoveGame(_fromState.channelType()).validStart(_fromState.balances(), _toState); */
        } else {
            // Two possibilities:
            // 1. Accept -> Accept transition
            // 2. Accept -> Conclude transition
            if (_toState.stateType() == CommonState.StateType.Accept) {
                // Accept -> Accept
                /* require(_toState.position() == _fromState.position()); */
                require(_toState.stateCount() == _fromState.stateCount() + 1);
                /* require(_toState.balances() == _fromState.balances(); */
            } else {
                // Accept -> Conclude
                require(_toState.stateType() == CommonState.StateType.Conclude);
                /* require(_toState.balances() == _fromState.balances(); */
            }
        }
        return true;
    }

    function validTransitionFromGame(bytes _fromState, bytes _toState) public pure returns (bool) {
        if (_toState.stateType() == CommonState.StateType.Game) {
            require(ForceMoveGame(_fromState.channelType()).validTransition(_fromState, _toState));
        } else {
            require(_toState.stateType() == CommonState.StateType.Conclude);
            /* require(ForceMoveGame(_fromState.channelType()).validConclusion(_fromState, _toState.balances())); */
        }
        return true;
    }

    function validTransitionFromConclude(bytes _fromState, bytes _toState) public pure returns (bool) {
        require(_toState.stateType() == CommonState.StateType.Conclude);
        /* require(_toState.balances() == _fromState.balances()); */
        return true;
    }
}