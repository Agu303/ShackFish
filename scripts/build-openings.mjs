import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Chess } from 'chess.js'

const directory = process.argv[2]
if (!directory) throw new Error('Pass the directory containing the five Lichess opening TSVs.')
const key = fen => fen.split(' ').slice(0, 4).join(' ')
const positions = new Map()
for (const volume of 'abcde') {
  const tsv = await readFile(join(directory, volume + '.tsv'), 'utf8')
  for (const row of tsv.trimEnd().split(/\r?\n/).slice(1)) {
    const [, , pgn] = row.split('\t')
    const chess = new Chess()
    chess.loadPgn(pgn)
    for (const move of chess.history({ verbose: true })) {
      const before = key(move.before)
      const moves = positions.get(before) ?? new Set()
      moves.add(move.san)
      positions.set(before, moves)
    }
  }
}
await writeFile(new URL('../src/assets/opening-book.json', import.meta.url),
  JSON.stringify(Object.fromEntries([...positions].map(([fen, moves]) => [fen, [...moves]]))) + '\n')
console.log(`Indexed ${positions.size} opening positions.`)
