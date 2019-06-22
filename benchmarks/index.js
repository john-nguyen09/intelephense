const fs = require('fs');
const path = require('path');
const SymbolStore_1 = require('../lib/symbolStore');
const Reference_1 = require('../lib/reference');
const ReferenceReader_1 = require('../lib/referenceReader');
const ParsedDocument_1 = require('../lib/parsedDocument');
const levelup = require('levelup');
const leveldown = require('leveldown');
const util = require('../lib/util');

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

async function indexPhpFile(filePath, symbolStore, referenceStore) {
	let start = process.hrtime();
    const parsedDoc = new ParsedDocument_1.ParsedDocument(
        filePath,
        fs.readFileSync(filePath).toString()
	);
	console.log(`ParsedDoc ${util.elapsed(start).toFixed(2)} ms`);
	start = process.hrtime();
	const symbolTable = SymbolStore_1.SymbolTable.create(parsedDoc);
	console.log(`SymbolTable created ${util.elapsed(start).toFixed(2)} ms`);
	start = process.hrtime();
	await symbolStore.add(symbolTable);
	console.log(`Index symbols ${util.elapsed(start).toFixed(2)} ms`);

	start = process.hrtime();
    const referenceTable = await ReferenceReader_1.ReferenceReader
        .discoverReferences(parsedDoc, symbolStore, symbolTable);
	referenceStore.add(referenceTable);
	console.log(`Index references ${util.elapsed(start).toFixed(2)} ms`);
}

const level = levelup(leveldown(path.join(__dirname, 'benchmark_store')));
const documentStore = new ParsedDocument_1.ParsedDocumentStore();
const symbolStore = new SymbolStore_1.SymbolStore(level, documentStore);
const referenceStore = new Reference_1.ReferenceStore();

const phpFiles = scanPhpFiles(path.join(__dirname, 'moodle'));

(async () => {
    for (const phpFile of phpFiles) {
		const start = process.hrtime();
		await indexPhpFile(phpFile, symbolStore, referenceStore);
		console.log(`Index ${phpFile} in ${util.elapsed(start).toFixed(2)} ms`);
    }
})();
