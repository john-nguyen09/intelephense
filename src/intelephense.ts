/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { ParsedDocument, ParsedDocumentStore, ParsedDocumentChangeEventArgs, LanguageRange } from './parsedDocument';
import { SymbolStore, SymbolTable } from './symbolStore';
import { SymbolProvider } from './symbolProvider';
import { CompletionProvider, CompletionOptions } from './completionProvider';
import { DiagnosticsProvider, PublishDiagnosticsEventArgs } from './diagnosticsProvider';
import { Debounce, Unsubscribe } from './types';
import { SignatureHelpProvider } from './signatureHelpProvider';
import { DefinitionProvider } from './definitionProvider';
import { PhraseType } from 'php7parser';
import { FormatProvider } from './formatProvider';
import * as lsp from 'vscode-languageserver-types';
import { InitializeParams } from 'vscode-languageserver-protocol';
import { MessageConnection } from 'vscode-jsonrpc';
import { NameTextEditProvider } from './commands';
import { ReferenceReader } from './referenceReader';
import { NameResolver } from './nameResolver';
import { ReferenceProvider } from './referenceProvider';
import { ReferenceStore, ReferenceTable } from './reference';
import { createCache, Cache, writeArrayToDisk, readArrayFromDisk } from './cache';
import { Log, LogWriter } from './logger';
import * as path from 'path';
export { LanguageRange } from './parsedDocument';
import { HoverProvider } from './hoverProvider';
import { HighlightProvider } from './highlightProvider';
import * as os from 'os';
import * as util from './util';
import * as fs from 'fs';
import * as gracefulFs from 'graceful-fs';
import Uri from 'vscode-uri';
gracefulFs.gracefulify(fs);

export namespace Intelephense {

    const phpLanguageId = 'php';
    const dataFolder = '.intelephense';

    let documentStore: ParsedDocumentStore;
    let symbolStore: SymbolStore;
    let refStore: ReferenceStore;
    let symbolProvider: SymbolProvider;
    let completionProvider: CompletionProvider;
    let diagnosticsProvider: DiagnosticsProvider;
    let signatureHelpProvider: SignatureHelpProvider;
    let definitionProvider: DefinitionProvider;
    let formatProvider: FormatProvider;
    let nameTextEditProvider: NameTextEditProvider;
    let referenceProvider: ReferenceProvider;
    let hoverProvider: HoverProvider;
    let highlightProvider: HighlightProvider;
    let cacheClear = false;

    let diagnosticsUnsubscribe: Unsubscribe;

    let cacheTimestamp = 0;
    let storagePath = '';

    export function onPublishDiagnostics(fn: (args: PublishDiagnosticsEventArgs) => void) {
        if (diagnosticsUnsubscribe) {
            diagnosticsUnsubscribe();
        }

        if (fn) {
            diagnosticsUnsubscribe = diagnosticsProvider.publishDiagnosticsEvent.subscribe(fn);
        }
    }

    export function initialise(options: InitialisationOptions) {
        return new Promise((resolve, reject) => {
            if (options && options.connection) {
                Log.connection = options.connection;
            }

            storagePath = (options && options.rootPath) ?
                path.join(os.homedir(), dataFolder, util.md5(options.rootPath)) : '';
            documentStore = new ParsedDocumentStore();
            symbolStore = new SymbolStore();
            refStore = new ReferenceStore();
            symbolProvider = new SymbolProvider(symbolStore);
            completionProvider = new CompletionProvider(symbolStore, documentStore, refStore);
            diagnosticsProvider = new DiagnosticsProvider();
            signatureHelpProvider = new SignatureHelpProvider(symbolStore, documentStore, refStore);
            definitionProvider = new DefinitionProvider(symbolStore, documentStore, refStore);
            formatProvider = new FormatProvider(documentStore);
            nameTextEditProvider = new NameTextEditProvider(symbolStore, documentStore, refStore);
            referenceProvider = new ReferenceProvider(documentStore, symbolStore, refStore);
            hoverProvider = new HoverProvider(documentStore, symbolStore, refStore);
            highlightProvider = new HighlightProvider(documentStore, symbolStore, refStore);

            //keep stores in sync
            documentStore.parsedDocumentChangeEvent.subscribe((args) => {
                symbolStore.onParsedDocumentChange(args);
                let refTable = ReferenceReader.discoverReferences(args.parsedDocument, symbolStore);
                refStore.add(refTable);
            });

            symbolStore.add(SymbolTable.readBuiltInSymbols());
            resolve();
        });
    }

    export function shutdown() {

        if(!storagePath) {
            return;
        }

        // No caching for now
        return;

    }

    export function provideHighlights(uri: string, position: lsp.Position) {
        return highlightProvider.provideHightlights(uri, position);
    }

    export function provideHover(uri: string, position: lsp.Position) {
        return hoverProvider.provideHover(uri, position);
    }

    export function knownDocuments() {
        //use ref uris because refs are determined last and may have been interrupted
        let known:string[] = [];
        for (let uri of refStore.knownDocuments()) {
            if (uri !== 'php') {
                known.push(uri);
            }
        }

        return { timestamp: cacheTimestamp, documents: known };
    }

    export function documentLanguageRanges(textDocument: lsp.TextDocumentIdentifier): LanguageRangeList {
        let doc = documentStore.find(textDocument.uri);
        return doc ? { version: doc.version, ranges: doc.documentLanguageRanges() } : undefined;
    }

    export function setConfig(config: IntelephenseConfig) {
        diagnosticsProvider.debounceWait = config.diagnosticsProvider.debounce;
        diagnosticsProvider.maxItems = config.diagnosticsProvider.maxItems;
        completionProvider.config = config.completionProvider;
    }

    export function openDocument(textDocument: lsp.TextDocumentItem) {

        if (textDocument.languageId !== phpLanguageId || documentStore.has(textDocument.uri)) {
            return;
        }

        let parsedDocument = new ParsedDocument(textDocument.uri, textDocument.text, textDocument.version);
        documentStore.add(parsedDocument);
        let symbolTable = SymbolTable.create(parsedDocument);
        symbolStore.add(symbolTable);
        try {
            let refTable = ReferenceReader.discoverReferences(parsedDocument, symbolStore);
            refStore.add(refTable);
            diagnosticsProvider.add(parsedDocument);
        } catch (err) {
            Log.error(err.stack);
        }
    }

    export function closeDocument(textDocument: lsp.TextDocumentIdentifier) {
        documentStore.remove(textDocument.uri);
        refStore.close(textDocument.uri);
        diagnosticsProvider.remove(textDocument.uri);
    }

    export function editDocument(
        textDocument: lsp.VersionedTextDocumentIdentifier,
        contentChanges: lsp.TextDocumentContentChangeEvent[]) {

        let parsedDocument = documentStore.find(textDocument.uri);
        if (parsedDocument) {
            parsedDocument.version = textDocument.version;
            parsedDocument.applyChanges(contentChanges);
        }

    }

    export function documentSymbols(textDocument: lsp.TextDocumentIdentifier) {
        flushParseDebounce(textDocument.uri);
        return symbolProvider.provideDocumentSymbols(textDocument.uri);
    }

    export function workspaceSymbols(query: string) {
        return query ? symbolProvider.provideWorkspaceSymbols(query) : [];
    }

    export function provideCompletions(textDocument: lsp.TextDocumentIdentifier, position: lsp.Position) {
        flushParseDebounce(textDocument.uri);

        let results: lsp.CompletionList = {
            items: [],
            isIncomplete: false
        };

        try {
            results = completionProvider.provideCompletions(textDocument.uri, position);
        } catch (err) {
            Log.error(err.message);
            Log.error(err.stack);
        }

        return results;
    }

    export function provideSignatureHelp(textDocument: lsp.TextDocumentIdentifier, position: lsp.Position) {
        flushParseDebounce(textDocument.uri);
        return signatureHelpProvider.provideSignatureHelp(textDocument.uri, position);
    }

    export function provideDefinition(textDocument: lsp.TextDocumentIdentifier, position: lsp.Position) {
        flushParseDebounce(textDocument.uri);
        return definitionProvider.provideDefinition(textDocument.uri, position);
    }

    export function discoverSymbols(textDocument: lsp.TextDocumentItem) {

        let uri = textDocument.uri;

        if (documentStore.has(uri)) {
            //if document is in doc store/opened then dont rediscover
            //it will have symbols discovered already
            let symbolTable = symbolStore.getSymbolTable(uri);
            return symbolTable ? symbolTable.symbolCount : 0;
        }

        let text = textDocument.text;
        let parsedDocument = new ParsedDocument(uri, text, textDocument.version);
        let symbolTable = SymbolTable.create(parsedDocument, true);
        symbolTable.pruneScopedVars();
        symbolStore.add(symbolTable);

        return symbolTable.symbolCount;
    }

    export function discoverReferences(textDocument: lsp.TextDocumentItem) {
        let uri = textDocument.uri;
        let refTable = refStore.getReferenceTable(uri);

        if (documentStore.has(uri)) {
            //if document is in doc store/opened then dont rediscover.
            //it should have had refs discovered already
            return refTable ? refTable.referenceCount : 0;
        }

        if (!symbolStore.getSymbolTable(uri)) {
            //symbols must be discovered first
            return 0;
        }

        let text = textDocument.text;
        let parsedDocument = new ParsedDocument(uri, text, textDocument.version);
        refTable = ReferenceReader.discoverReferences(parsedDocument, symbolStore);
        refStore.add(refTable);
        refStore.close(refTable.uri);
        return refTable.referenceCount;
    }

    export function forget(uri: string) {
        symbolStore.remove(uri);
        refStore.remove(uri, true);
    }

    export function provideContractFqnTextEdits(uri: string, position: lsp.Position, alias?: string) {
        flushParseDebounce(uri);
        return nameTextEditProvider.provideContractFqnTextEdits(uri, position, alias);
    }

    export function numberDocumentsOpen() {
        return documentStore.count;
    }

    export function numberDocumentsKnown() {
        return symbolStore.tableCount;
    }

    export function numberSymbolsKnown() {
        return symbolStore.symbolCount;
    }

    export function provideDocumentFormattingEdits(doc: lsp.TextDocumentIdentifier, formatOptions: lsp.FormattingOptions) {
        flushParseDebounce(doc.uri);
        return formatProvider.provideDocumentFormattingEdits(doc, formatOptions);
    }

    export function provideDocumentRangeFormattingEdits(doc: lsp.TextDocumentIdentifier, range: lsp.Range, formatOptions: lsp.FormattingOptions) {
        flushParseDebounce(doc.uri);
        return formatProvider.provideDocumentRangeFormattingEdits(doc, range, formatOptions);
    }

    export function provideReferences(doc: lsp.TextDocumentIdentifier, pos: lsp.Position, context: lsp.ReferenceContext) {
        flushParseDebounce(doc.uri);
        return referenceProvider.provideReferenceLocations(doc.uri, pos, context);
    }

    function flushParseDebounce(uri: string) {
        let parsedDocument = documentStore.find(uri);
        if (parsedDocument) {
            parsedDocument.flush();
        }
    }

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

    export function indexDirectory(directory) {
        let phpFiles = scanPhpFiles(directory);
        let textDocuments = [];
        let docPromises: Promise<lsp.TextDocumentItem>[] = [];

        const createDocAsync = (filePath) => {
            return new Promise<lsp.TextDocumentItem>((resolve, reject) => {
                try {
                    fs.readFile(filePath, (err, buffer) => {
                        if (err) {
                            reject(err);
                        } else {
                            resolve(lsp.TextDocumentItem.create(
                                util.pathToUri(filePath),
                                phpLanguageId,
                                0,
                                buffer.toString()
                            ));
                        }
                    });
                } catch (err) {
                    reject(err);
                }
            });
        };

        for (let phpFile of phpFiles) {
            docPromises.push(createDocAsync(phpFile));
        }

        Promise.all(docPromises).then((documents) => {
            Log.info(`Discover ${documents.length} php files to index`);
            const start = process.hrtime();

            const discoverSymbols = (index: number) => {
                Intelephense.discoverSymbols(documents[index]);

                if (index < documents.length) {
                    setImmediate(() => {
                        discoverSymbols(index + 1);
                    });
                }
            };

            const discoverReferences = (index: number) => {
                Intelephense.discoverReferences(documents[index]);

                if (index < documents.length) {
                    setImmediate(() => {
                        discoverReferences(index + 1);
                    });
                }
            };

            const waitForNextTick = () => {
                return new Promise<void>((resolve, reject) => {
                    setImmediate(() => {
                        resolve();
                    })
                })
            }

            let promiseChain = waitForNextTick();

            for (let document of documents) {
                promiseChain = promiseChain.then(() => {
                    Intelephense.discoverSymbols(document);
                }).then(waitForNextTick);
            }
            for (let document of documents) {
                promiseChain = promiseChain.then(() => {
                    Intelephense.discoverReferences(document);
                }).then(waitForNextTick);
            }

            promiseChain.then(() => {
                const elapsedHr = process.hrtime(start);
                const elapsed = elapsedHr[0] + (elapsedHr[1] / 1000000000);

                Log.info(`Indexing finished in ${elapsed} seconds`);
            })
        }).catch((err) => {
            throw err;
        });
    }

}

export interface IntelephenseConfig {
    debug: {
        enable: boolean;
    },
    diagnosticsProvider: {
        debounce: number,
        maxItems: number
    },
    completionProvider: {
        maxItems: number,
        addUseDeclaration: boolean,
        backslashPrefix: boolean
    },
    file: {
        maxSize: number
    }
}

export interface InitialisationOptions extends InitializeParams {
    connection?: any;
}

export interface LanguageRangeList {
    version: number;
    ranges: LanguageRange[]
}

