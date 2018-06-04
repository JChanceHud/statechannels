pragma solidity ^0.4.18;

library CommonState {
    enum StateType { Propose, Accept, Game, Conclude }

    // Common State Fields
    // ===================
    // [  0 -  31] (bytestring meta info)
    // [ 32 -  63] address channelType
    // [ 64 -  95] uint256 channelNonce
    // [ 96 - 127] uint256 numberOfParticipants
    // [128 - x-1] address[] participants
    // ----------- where x = 128 + 32 * numberOfParticipants
    // x + [ 0 - 31] uint256 stateType
    // x + [32 - 63] uint256 turnNum
    // x + [64 - 95] uint256 stateCount // only relevant for Propose and Accept states
    // x + [96 - y-1] uint256[] resolution
    // ----------- where y = 224 + 64 * numberOfParticipants
    // y + [0 -  ?] bytes gameState

    function channelType(bytes _state) public pure returns (address _channelType) {
        assembly {
            _channelType := mload(add(_state, 32))
        }
    }

    function channelNonce(bytes _state) public pure returns (uint _channelNonce) {
        assembly {
            _channelNonce := mload(add(_state, 64))
        }
    }

    function numberOfParticipants(bytes _state) public pure returns (uint _numberOfParticipants) {
        assembly {
            _numberOfParticipants := mload(add(_state, 96))
        }

        require(_numberOfParticipants == 2); // for now
    }

    function participants(bytes _state) public pure returns (address[] ) {
        address currentParticipant;
        uint256 n = numberOfParticipants(_state);
        address[] memory extractedParticipants = new address[](n);

        for(uint i = 0; i < n; i++) {
            assembly {
                currentParticipant := mload(add(_state, add(128, mul(32, i))))
            }

            extractedParticipants[i] = currentParticipant;
        }
        return extractedParticipants;
    }

    function participant(bytes _state, uint _index) public pure returns (address _participant) {
        uint256 n = numberOfParticipants(_state);
        require(_index < n);

        assembly {
            _participant := mload(add(_state, add(128, mul(32, _index))))
        }
    }

    function stateType(bytes _state) public pure returns (StateType _stateType) {
        uint256 offset = numberOfParticipants(_state) * 32 + 128;
        assembly {
            _stateType := mload(add(_state, offset))
        }
    }

    function turnNum(bytes _state) public pure returns (uint _turnNum) {
        uint256 offset = 32 + numberOfParticipants(_state) * 32 + 128;
        assembly {
            _turnNum := mload(add(_state, offset))
        }
    }

    function stateCount(bytes _state) public pure returns (uint _stateCount) {
        uint256 offset = 64 + numberOfParticipants(_state) * 32 + 128;
        assembly {
            _stateCount := mload(add(_state, offset))
        }
    }

    function resolution(bytes _state) public pure returns (uint256[] ) {
        uint256 currentResolutionValue;
        uint256 n = numberOfParticipants(_state);
        uint256[] memory extractedResolution = new uint256[](n);

        for(uint i = 0; i < n; i++) {
            assembly {
                currentResolutionValue := mload(add(_state, add(224, mul(32, add(i, n)))))
            }

            extractedResolution[i] = currentResolutionValue;
        }
        return extractedResolution;
    }

    function channelId(bytes _state) public pure returns (bytes32) {
        return keccak256(channelType(_state), channelNonce(_state), participants(_state));
    }

    function mover(bytes _state) public pure returns (address) {
        return participants(_state)[turnNum(_state) % numberOfParticipants(_state)];
    }

    function indexOfMover(bytes _state) public pure returns (uint) {
        return turnNum(_state) % numberOfParticipants(_state);
    }

    function requireSignature(bytes _state, uint8 _v, bytes32 _r, bytes32 _s) public pure {
        require(mover(_state) == recoverSigner(_state, _v, _r, _s));
    }

    function requireFullySigned(bytes _state, uint8[] _v, bytes32[] _r, bytes32[] _s) public pure {
        uint256 n = numberOfParticipants(_state);
        address[] memory p = participants(_state);

        for(uint i = 0; i < n; i++) {
            require(p[i] == recoverSigner(_state, _v[i], _r[i], _s[i]));
        }
    }

    function gameStateOffset(bytes _state) public pure returns (uint) {
        return 224 + 64 * numberOfParticipants(_state);
    }

    // utilities
    // =========

    function recoverSigner(bytes _d, uint8 _v, bytes32 _r, bytes32 _s) internal pure returns(address) {
        bytes memory prefix = "\x19Ethereum Signed Message:\n32";
        bytes32 h = keccak256(_d);

        bytes32 prefixedHash = keccak256(prefix, h);

        address a = ecrecover(prefixedHash, _v, _r, _s);

        return(a);
    }
}
