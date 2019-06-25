import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Node, Phrase, Token, ParseError, Parser, tokenKindToString, phraseKindToString } from 'php7parser';
import { nodeToObject } from '../src/util';

const readDirAsync = promisify(fs.readdir);
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

describe('create AST', async () => {
    const caseDir = path.join(__dirname, 'fixtures');
    const files = await readDirAsync(caseDir);
    const promises: Promise<void>[] = [];

    for (const file of files) {
        const filePath = path.join(caseDir, file);

        if (path.extname(file) === '.php') {
            const data = await readFileAsync(filePath);
            const src = data.toString();
            const tree = Parser.parse(src);

            promises.push(
                writeFileAsync(
                    path.join(caseDir, file + '.json'),
                    JSON.stringify(nodeToObject(tree), null, 4)
                )
            );
        }
    }

    await Promise.all(promises);
});