# Engine and artwork notes

## Stockfish

ShackFish uses the official Stockfish 19 Windows x86-64 universal engine via the Universal Chess Interface (UCI). Its analysis requests include the initial FEN and preceding moves so the engine can account for repetition. Chess rules and move validation are handled with chess.js.

[Engine source and archive verification](engine/SOURCE.txt) identifies the exact official binary, SHA-256, and corresponding source commit. Stockfish's [GPL notice](engine/Copying.txt) and [author list](engine/AUTHORS) are included. If you distribute a packaged build that bundles Stockfish, keep these notices with it and make the corresponding source available under Stockfish's license.

Engine Autopsy uses the same UCI adapter for both executables. It compares positions using matching requested search settings. Different engines may interpret evaluation values differently. Use the report to investigate how two builds behave on specific positions.

## Review scoring

ShackFish uses the published [Lichess win-chance and move accuracy equations](https://lichess.org/page/accuracy) as part of its own move classification and per-player accuracy. It averages scored moves, excludes book and forced moves, and gives full credit to the engine's top choice. Book detection uses the bundled opening lookup. The Brilliant label uses a heuristic for material sacrifices that the engine approves.

The performance rating is an estimate from a single game. It blends move quality with the PGN rating when a valid Elo tag is present and requires at least five scored moves. Quick Review and the scouting sample use shorter searches, so deeper reviews can change individual findings.

## Artwork and third-party credits

[Third-party notices](public/THIRD-PARTY.txt) credit the chess pieces, opening data, typeface, and icons. The app's logo is in [public/logo.png](public/logo.png), and the app loads its [mascot sprites](src/assets/ShackFish%20Reactions/sprites) locally. The art was made from supplied references and includes a recognizable likeness. Review permissions for the artwork and likeness before redistributing them. Stockfish's license applies to Stockfish and does not grant rights to the mascot artwork.
