import * as fs from 'fs';
import * as path from 'path';

const stubFiles = [
    'builtInSymbols.json'
];

for (let file of stubFiles) {
    fs.copyFile(
        path.join(__dirname, '../src', file),
        path.join(__dirname, file),
        (err) => {
            if (err) {
                throw err;
            }
        }
    );
}