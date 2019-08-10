/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { ParsedDocument, ParsedDocumentStore, LanguageRange } from './parsedDocument';
import { SymbolStore, SymbolTable } from './symbolStore';
import { SymbolProvider } from './providers/symbolProvider';
import { CompletionProvider } from './providers/completionProvider';
import { DiagnosticsProvider, PublishDiagnosticsEventArgs } from './providers/diagnosticsProvider';
import { Unsubscribe } from './types';
import { SignatureHelpProvider } from './providers/signatureHelpProvider';
import { DefinitionProvider } from './providers/definitionProvider';
import * as lsp from 'vscode-languageserver-types';
import { InitializeParams } from 'vscode-languageserver-protocol';
import { NameTextEditProvider } from './commands';
import { ReferenceReader } from './referenceReader';
import { ReferenceProvider } from './providers/referenceProvider';
import { ReferenceStore } from './reference';
import { Log } from './logger';
import * as path from 'path';
export { LanguageRange } from './parsedDocument';
import { HoverProvider } from './providers/hoverProvider';
import { HighlightProvider } from './providers/highlightProvider';
import * as os from 'os';
import * as util from './utils';
import * as fs from 'fs';
import * as gracefulFs from 'graceful-fs';
import Uri from 'vscode-uri';
import { LevelUp } from 'levelup';
import LevelUpConstructor from 'levelup';
import LevelDOWN from 'leveldown';
import MemDown from 'memdown';
import { IConnection } from 'vscode-languageserver';
import { promisify } from 'util';
gracefulFs.gracefulify(fs);
const statAsync = promisify(fs.stat);

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
    let nameTextEditProvider: NameTextEditProvider;
    let referenceProvider: ReferenceProvider;
    let hoverProvider: HoverProvider;
    let highlightProvider: HighlightProvider;
    let level: LevelUp;

    let diagnosticsUnsubscribe: Unsubscribe;

    let cacheTimestamp = 0;
    let storagePath: string | null = null;

    export function onPublishDiagnostics(fn: (args: PublishDiagnosticsEventArgs) => void) {
        if (diagnosticsUnsubscribe) {
            diagnosticsUnsubscribe();
        }

        if (fn) {
            diagnosticsUnsubscribe = diagnosticsProvider.publishDiagnosticsEvent.subscribe(fn);
        }
    }

    export function initialise(params: InitializeParams | null) {
        const initialisedAt = process.hrtime();

        Log.info('Initialising');
    
        storagePath = (params && params.rootPath) ?
            path.join(os.homedir(), dataFolder, util.md5(params.rootPath)) : null;
        
        if (storagePath !== null) {
            level = LevelUpConstructor(LevelDOWN(storagePath));
        } else {
            level = LevelUpConstructor(MemDown());
        }
        documentStore = new ParsedDocumentStore();
        symbolStore = new SymbolStore(level, documentStore);
        refStore = new ReferenceStore();
        symbolProvider = new SymbolProvider(symbolStore, documentStore);
        completionProvider = new CompletionProvider(symbolStore, documentStore, refStore);
        diagnosticsProvider = new DiagnosticsProvider();
        signatureHelpProvider = new SignatureHelpProvider(symbolStore, documentStore, refStore);
        definitionProvider = new DefinitionProvider(symbolStore, documentStore, refStore);
        nameTextEditProvider = new NameTextEditProvider(symbolStore, documentStore, refStore);
        referenceProvider = new ReferenceProvider(documentStore, symbolStore, refStore);
        hoverProvider = new HoverProvider(documentStore, symbolStore, refStore);
        highlightProvider = new HighlightProvider(documentStore, symbolStore, refStore);

        //keep stores in sync
        documentStore.parsedDocumentChangeEvent.subscribe((args) => {
            documentStore.acquireLock(args.parsedDocument.uri, () => {
                return symbolStore
                    .onParsedDocumentChange(args)
                    .then(symbolTable => {
                        return ReferenceReader.discoverReferences(args.parsedDocument, symbolStore, symbolTable)
                    })
                    .then(refTable => {
                        refStore.add(refTable);
                    })
                    .catch(err => {
                        Log.error(err);
                    });
            });
        });

        const builtinSymbolTable = SymbolTable.readBuiltInSymbols();

        return symbolStore.add(builtinSymbolTable)
            .then(_ => {
                Log.info(`Initialised in ${util.elapsed(initialisedAt).toFixed()} ms`);
                let rootUri: string | null = null;

                if (params) {
                    if (params.rootUri) {
                        rootUri = params.rootUri;
                    } else if (params.rootPath) {
                        rootUri = util.pathToUri(params.rootPath);
                    }
                }

                if (rootUri) {
                    Intelephense.indexDirectory(Uri.parse(rootUri).fsPath);
                }
            })
            .catch(err => {
                Log.error(err);
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

        documentStore.acquireLock(parsedDocument.uri, async () => {
            let symbolTable = SymbolTable.create(parsedDocument, 0);
            await symbolStore.add(symbolTable)
                .then(_ => {
                    return ReferenceReader.discoverReferences(parsedDocument, symbolStore);
                })
                .then(refTable => {
                    if (refTable) {
                        refStore.add(refTable);
                    }
                    diagnosticsProvider.add(parsedDocument);
                })
                .catch(err => {
                    Log.error(err);
                });
        });
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
            parsedDocument.version = textDocument.version || 0;
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

    export async function provideCompletions(textDocument: lsp.TextDocumentIdentifier, position: lsp.Position) {
        flushParseDebounce(textDocument.uri);

        let results: lsp.CompletionList = {
            items: [],
            isIncomplete: false
        };

        try {
            results = await completionProvider.provideCompletions(textDocument.uri, position);
        } catch (err) {
            Log.error(err);
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

    export async function discoverSymbols(textDocument: lsp.TextDocumentItem) {

        const uri = textDocument.uri;
        let symbolTable = await symbolStore.getSymbolTable(uri);
        const filePath = util.uriToPath(uri);
        const fstats = await statAsync(filePath);
        const fileModifiedTime = Math.floor(fstats.mtime.getTime() / 1000);

        if (symbolTable !== undefined && symbolTable.modifiedTime === fileModifiedTime) {
            return false;
        }

        const parsedDocument = new ParsedDocument(uri, textDocument.text, textDocument.version);
        symbolTable = SymbolTable.create(parsedDocument, fileModifiedTime);
        symbolTable.pruneScopedVars();
        await symbolStore.add(symbolTable);

        return true;
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

    export function indexDirectory(directory) {
        let phpFiles = scanPhpFiles(directory);
        let docPromises: Promise<lsp.TextDocumentItem>[] = [];

        const createDocAsync = (filePath) => {
            return new Promise<lsp.TextDocumentItem>((resolve, reject) => {
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
            });
        };

        for (let phpFile of phpFiles) {
            docPromises.push(createDocAsync(phpFile));
        }

        const start = process.hrtime();
        
        return Promise.all(docPromises).then(async (documents) => {
            Log.info(`Discover ${documents.length} php files to index`);

            const waitForNextTick = () => {
                return new Promise<void>((resolve, _) => {
                    setImmediate(() => {
                        resolve();
                    });
                })
            };

            let reindexCount = 0;
            for (let document of documents) {
                if (await Intelephense.discoverSymbols(document)) {
                    reindexCount++;
                }
                // Wait for next tick so that any pending requests can be executed
                // await waitForNextTick();
            }
        })
        .then(_ => {
            const elapsedHr = process.hrtime(start);
            const elapsed = elapsedHr[0] + (elapsedHr[1] / 1000000000);

            Log.info(`Indexing finished in ${elapsed} seconds`);
        })
        .catch(err => {
            Log.error(err);
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
    }
}

export interface InitialisationOptions extends InitializeParams {
    connection: IConnection;
}

export interface LanguageRangeList {
    version: number;
    ranges: LanguageRange[]
}

