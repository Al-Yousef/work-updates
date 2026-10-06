#pragma once
struct WeatherInputPolicy {
    bool inside=false, leftOwned=false, rightOwned=false;
    // A press originating outside the tile must stay with its original owner.
    bool down(bool inTile, bool right=false) {
        auto& owned=right?rightOwned:leftOwned;
        owned=inTile; return owned;
    }
    bool up(bool inTile, bool& activate, bool right=false) {
        auto& owned=right?rightOwned:leftOwned;
        const bool consumed=owned;
        activate=owned && inTile; owned=false; return consumed;
    }
};
