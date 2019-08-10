import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { ParsedDocument } from '../src/parsedDocument';
import { SymbolReader } from '../src/symbolReader';
import { pathToUri, elapsed } from '../src/utils';
import { NameResolver } from '../src/nameResolver';

const readFileAsync = promisify(fs.readFile);

export function scanPhpFiles(directory) {
    let phpFiles: string[] = [];
    let files = fs.readdirSync(directory);

    for (let file of files) {
        let filePath = path.join(directory, file);

        if (file.endsWith('.php')) {
            phpFiles.push(filePath);

            continue;
        }

        const stats = fs.lstatSync(filePath);
        if (stats.isDirectory()) {
            Array.prototype.push.apply(phpFiles, scanPhpFiles(filePath));
        }
    }

    return phpFiles;
}

async function main(){
    const caseDir = path.join('C:\\Users\\johnn\\Development\\moodle-lite');
    const files = await scanPhpFiles(caseDir);

    console.log('File,Parsing time, Read symbols time');
    for (const filePath of files) {
        const data = await readFileAsync(filePath);
        const src = data.toString();
        
        const startParsing = process.hrtime();
        const parsedDoc = new ParsedDocument(pathToUri(filePath), src);
        const parsingTime = elapsed(startParsing);

        const startSymbol = process.hrtime();
        const symbolReader = new SymbolReader(parsedDoc, new NameResolver());

        try {
            parsedDoc.traverse(symbolReader);
        } catch (e) {
            console.error(e);
        }
        const symbolTime = elapsed(startSymbol);

        console.log(`${filePath},${parsingTime.toFixed(2)},${symbolTime.toFixed(2)}`);
    }
};

main();