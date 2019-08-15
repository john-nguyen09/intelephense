import { LevelUp } from "levelup";
import LevelUpConstructor from "levelup";
import { ParsedDocumentStore, ParsedDocument } from "./parsedDocument";
import { SymbolStore, SymbolTable } from "./symbolStore";
import { InitializeParams, CodeLensParams, CodeLens, Command, InitializeResult, createConnection, TextDocumentSyncKind, DidOpenTextDocumentParams, DidChangeTextDocumentParams } from "vscode-languageserver";
import MemDown from "memdown";
import { promisify } from "util";
import * as fs from "fs";
import { SymbolReader } from "./symbolReader";
import { NameResolver } from "./nameResolver";
import { ReferenceReader } from "./referenceReader";
import { TreeVisitor, TreeTraverser } from "./types";
import { Reference, Scope } from "./reference";
import { symbolKindToString } from "./symbol";
import { TypeString } from "./typeString";
import * as path from "path";
import * as os from "os";
import { SyntaxNode } from "tree-sitter";
import { uriToFilePath } from "vscode-languageserver/lib/files";

const readFileAsync = promisify(fs.readFile);

export namespace MockServer {
    let level: LevelUp;
    let documentStore: ParsedDocumentStore;
    let symbolStore: SymbolStore;

    export function initialise(params: InitializeParams): InitializeResult {
        level = LevelUpConstructor(MemDown());
        documentStore = new ParsedDocumentStore();
        symbolStore = new SymbolStore(level, documentStore);
        console.log('Mock server is initialised');

        return {
            capabilities: {
                codeLensProvider: {
                    resolveProvider: false,
                },
                textDocumentSync: TextDocumentSyncKind.Incremental,
            }
        };
    }

    export async function didOpenTextDocument(params: DidOpenTextDocumentParams) {
        const fileContent = (await readFileAsync(uriToFilePath(params.textDocument.uri))).toString('utf-8');
        const parsedDocument = new ParsedDocument(params.textDocument.uri, fileContent);
        documentStore.add(parsedDocument);
    }

    export async function changeTextDocument(params: DidChangeTextDocumentParams) {
        const parsedDocument = documentStore.find(params.textDocument.uri);
        if (!parsedDocument) {
            return;
        }

        parsedDocument.applyChanges(params.contentChanges);
    }

    export async function codeLens(params: CodeLensParams): Promise<CodeLens[] | null> {
        return astCodeLens(params);
    }

    export function astCodeLens(params: CodeLensParams): CodeLens[] | null {
        const parsedDocument = documentStore.find(params.textDocument.uri);
        if (!parsedDocument) {
            console.error('No opened document');
            return null;
        }
        
        const codeLens: CodeLens[] = [];

        parsedDocument.traverse(new class implements TreeVisitor<SyntaxNode> {
            preorder(node: SyntaxNode, spine: SyntaxNode[]): boolean {
                if (node.childCount === 0) {
                    return true;
                }

                codeLens.push({
                    range: parsedDocument.nodeRange(node),
                    command: Command.create(JSON.stringify({
                        type: node.type,
                        hasChanges: node.hasChanges(),
                    }), ''),
                });

                return true;
            }
        });

        return codeLens;
    }

    export async function referenceCodeLens(params: CodeLensParams): Promise<CodeLens[] | null> {
        const parsedDocument = documentStore.find(params.textDocument.uri);

        if (!parsedDocument) {
            return null;
        }

        const symbolReader = new SymbolReader(parsedDocument, new NameResolver());

        parsedDocument.traverse(symbolReader);
        await symbolStore.add(new SymbolTable(parsedDocument.uri, symbolReader.symbol, 0));
        const refTable = await ReferenceReader.discoverReferences(parsedDocument, symbolStore);
        const promises: Promise<CodeLens>[] = [];

        const visitor: TreeVisitor<Scope | Reference> = {
            preorder: (reference: Scope | Reference): boolean => {
                if ('kind' in reference) {
                    promises.push((async (): Promise<CodeLens> => {
                        return {
                            range: reference.location.range,
                            command: Command.create('ref', symbolKindToString(reference.kind) + ' # ' + await TypeString.resolve(reference.type)),
                        };
                    })());
                } else {
                    promises.push((async (): Promise<CodeLens> => {
                        return {
                            range: reference.location.range,
                            command: Command.create('scope', ''),
                        };
                    })());
                }

                return false;
            }
        };

        const traverser = new TreeTraverser<Scope | Reference>([refTable.root]);
        traverser.traverse(visitor);

        return await Promise.all(promises);
    }
}

const logPath = path.join(os.homedir(), '.intelephense', 'error.log');

process.on('uncaughtException', function (err) {
	fs.appendFileSync(logPath, (new Date).toUTCString() + ' uncaughtException:' + err.message);
	fs.appendFileSync(logPath, err.stack);
	process.exit(1);
});

const connection = createConnection();

connection.onInitialize(MockServer.initialise);
connection.onCodeLens(MockServer.codeLens);
connection.onDidOpenTextDocument(MockServer.didOpenTextDocument);
connection.onDidChangeTextDocument(MockServer.changeTextDocument);
connection.listen();
