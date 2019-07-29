import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { ParsedDocument } from '../src/parsedDocument';
import { SymbolReader } from '../src/symbolReader';
import { pathToUri } from '../src/utils';
import { NameResolver } from '../src/nameResolver';
import { symbolKindToString, modifiersToString } from '../src/symbol';

const readDirAsync = promisify(fs.readdir);
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

async function main(){
    const caseDir = path.join(__dirname, '..', 'test', 'fixtures');
    const files = await readDirAsync(caseDir);

    for (const file of files) {
        const filePath = path.join(caseDir, file);

        if (path.extname(file) === '.php') {
            const data = await readFileAsync(filePath);
            const src = data.toString();
            
            const parsedDoc = new ParsedDocument(pathToUri(filePath), src);
            const symbolReader = new SymbolReader(parsedDoc, new NameResolver());

            try {
                parsedDoc.traverse(symbolReader);
            } catch (e) {
                console.error(e);
            }

            await writeFileAsync(
                filePath + '.symbols',
                JSON.stringify(symbolReader.symbol, (key, value) => {
                    if (key === 'kind') {
                        return symbolKindToString(value);
                    }
                    if (key === 'modifiers') {
                        return modifiersToString(value);
                    }
                    
                    return value;
                }, 4),
            );
        }
    }
};

main();