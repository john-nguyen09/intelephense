const fs = require('fs');
const path = require('path');
const SymbolStore_1 = require('../lib/symbolStore');
const Reference_1 = require('../lib/reference');
const ReferenceReader_1 = require('../lib/referenceReader');
const ParsedDocument_1 = require('../lib/parsedDocument');
const Cache_1 = require('../lib/cache');

const phpFiles = scanPhpFiles(path.join(__dirname, 'moodle'));
const symbolStore = new SymbolStore_1.SymbolStore();
const referenceStore = new Reference_1.ReferenceStore(new Cache_1.MemoryCache());

indexPhpFiles(phpFiles, symbolStore);
const startHr = process.hrtime();
indexReferences(phpFiles, referenceStore, symbolStore);
const elapsedHr = process.hrtime(startHr);
const elapsed = elapsedHr[0];

console.log(`Finished in ${elapsed} seconds`);
console.log(`Used ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`);

function scanPhpFiles(directory) {
	let phpFiles = [];
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

function indexPhpFiles(filePaths, symbolStore) {
	for (let filePath of filePaths) {
		let parsedDoc = new ParsedDocument_1.ParsedDocument(filePath, fs.readFileSync(filePath).toString());

		symbolStore.add(SymbolStore_1.SymbolTable.create(parsedDoc));
	}
}

function indexReferences(filePaths, referenceStore, symbolStore) {
	for (let filePath of filePaths) {
		let parsedDoc = new ParsedDocument_1.ParsedDocument(filePath, fs.readFileSync(filePath).toString());

		referenceStore.add(ReferenceReader_1.ReferenceReader.discoverReferences(parsedDoc, symbolStore));
	}
}
