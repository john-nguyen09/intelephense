import { SymbolStore, SymbolTable } from '../src/symbolStore';
import { SymbolProvider } from '../src/symbolProvider';
import * as util from '../src/util';
import { assert } from 'chai';
import 'mocha';
import * as fs from 'fs';
import * as path from 'path';
import { ParsedDocument } from '../src/parsedDocument';
import * as lsp from 'vscode-languageserver-types';

describe('symbolProviders', () => {
    it('provide symbols', () => {
        let src = fs.readFileSync(path.join(__dirname, '/fixtures/symbols.php')).toString();
        let symbolStore = new SymbolStore();
        let document = new ParsedDocument('test', src);
        let symbolTable = SymbolTable.create(document);

        symbolStore.add(symbolTable);

        let symbolProvider = new SymbolProvider(symbolStore);

        let results = symbolProvider.provideDocumentSymbols('test');
        let expected = [
            { kind: lsp.SymbolKind.Constant, name: 'TEST_CONST', location: {
                uri: 'test', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 23 } }
            }, containerName: undefined } as lsp.SymbolInformation,
            { kind: lsp.SymbolKind.Function, name: 'testFunction', location: {
                uri: 'test', range: { start: { line: 6, character: 0 }, end: { line: 9, character: 1 } }
            }, containerName: undefined },
            { kind: lsp.SymbolKind.Class, name: 'TestClass', location: {
                uri: 'test', range: { start: { line: 11, character: 0 }, end: { line: 26, character: 1 } }
            }, containerName: undefined },
            { kind: lsp.SymbolKind.Constant, name: 'CLASS_CONSTANT', location: {
                uri: 'test', range: { start: { line: 13, character: 10 }, end: { line: 13, character: 28 } }
            }, containerName: 'TestClass' },
            { kind: lsp.SymbolKind.Method, name: 'testMethod', location: {
                uri: 'test', range: { start: { line: 17, character: 4 }, end: { line: 20, character: 5 } }
            }, containerName: 'TestClass' },
            { kind: lsp.SymbolKind.Method, name: 'testMethod2', location: {
                uri: 'test', range: { start: { line: 22, character: 4 }, end: { line: 25, character: 5 } }
            }, containerName: 'TestClass' },
            { kind: lsp.SymbolKind.Interface, name: 'TestInterface', location: {
                uri: 'test', range: { start: { line: 28, character: 0 }, end: { line: 32, character: 1 } }
            }, containerName: undefined },
            { kind: lsp.SymbolKind.Method, name: 'testInterfaceMethod', location: {
                uri: 'test', range: { start: { line: 30, character: 4 }, end: { line: 30, character: 42 } }
            }, containerName: 'TestInterface' },
            { kind: lsp.SymbolKind.Method, name: 'testInterfaceMethod2', location: {
                uri: 'test', range: { start: { line: 31, character: 4 }, end: { line: 31, character: 43 } }
            }, containerName: 'TestInterface' }
        ];

        assert.deepEqual(results, expected);
    });
});
