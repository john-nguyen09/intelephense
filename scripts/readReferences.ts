import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { ParsedDocument, ParsedDocumentStore } from '../src/parsedDocument';
import { SymbolReader } from '../src/symbolReader';
import { ReferenceReader } from '../src/referenceReader';
import { pathToUri } from '../src/utils';
import { NameResolver } from '../src/nameResolver';
import { SymbolStore, SymbolTable } from '../src/symbolStore';
import LevelConstructor from 'levelup';
import MemDown from 'memdown';
import { symbolKindToString } from '../src/symbol';

const readDirAsync = promisify(fs.readdir);
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

async function main() {
    const caseDir = path.join(__dirname, '..', 'test', 'fixtures');
    const files = await readDirAsync(caseDir);
    const level = LevelConstructor(MemDown());
    const documentStore = new ParsedDocumentStore();
    const symbolStore = new SymbolStore(level, documentStore);

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

            documentStore.add(parsedDoc);
            await symbolStore.add(new SymbolTable(parsedDoc.uri, symbolReader.symbol, 0));
        }
    }

    for (const file of files) {
        const filePath = path.join(caseDir, file);

        if (path.extname(file) === '.php') {
            const doc = documentStore.find(pathToUri(filePath));
            const refTable = await ReferenceReader.discoverReferences(doc, symbolStore);
            
            await writeFileAsync(
                filePath + '.refs',
                JSON.stringify(refTable.root, (key, value) => {
                    if (key === 'kind') {
                        return symbolKindToString(value);
                    }
                    
                    return value;
                }, 4),
            );
        }
    }
}

main();