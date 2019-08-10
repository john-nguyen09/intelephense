import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { Parser } from '../src/parser';
import { Formatter } from '../src/utils/formatter';

const readDirAsync = promisify(fs.readdir);
const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

async function main(){
    const caseDir = path.join(__dirname, '..', 'test', 'fixtures');
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
                    path.join(caseDir, file + '.ast'),
                    Formatter.toString(tree.rootNode),
                )
            );
        }
    }

    await Promise.all(promises);
};

main();