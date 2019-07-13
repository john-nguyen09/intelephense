import { LevelUp } from "levelup";
import LevelUpConstructor from "levelup";
import { ParsedDocumentStore, ParsedDocument } from "./parsedDocument";
import { SymbolStore, SymbolTable } from "./symbolStore";
import { InitializeParams, CodeLensParams, CodeLens, Command, InitializeResult, createConnection } from "vscode-languageserver";
import MemDown from "memdown";
import { promisify } from "util";
import * as fs from "fs";
import { pathToUri } from "./utils";
import { SymbolReader } from "./symbolReader";
import { NameResolver } from "./nameResolver";
import { ReferenceReader } from "./referenceReader";
import { TreeVisitor, TreeTraverser } from "./types";
import { Reference, Scope } from "./reference";
import { symbolKindToString } from "./symbol";
import { TypeString } from "./typeString";
import * as path from "path";
import * as os from "os";

const readFileAsync = promisify(fs.readFile);

export namespace MockServer {
    let level: LevelUp;
    let documentStore: ParsedDocumentStore;
    let symbolStore: SymbolStore;

    export function initialise(params: InitializeParams): InitializeResult {
        level = LevelUpConstructor(MemDown());
        documentStore = new ParsedDocumentStore();
        symbolStore = new SymbolStore(level, documentStore);

        return {
            capabilities: {
                codeLensProvider: {
                    resolveProvider: false,
                }
            }
        };
    }

    export async function codeLens(params: CodeLensParams): Promise<CodeLens[] | null> {
        const fileContent = (await readFileAsync(pathToUri(params.textDocument.uri))).toString('utf-8');
        const parsedDocument = new ParsedDocument(params.textDocument.uri, fileContent);
        const symbolReader = new SymbolReader(parsedDocument, new NameResolver());

        try {
            parsedDocument.traverse(symbolReader);
        } catch (e) {
            console.error(e);
        }

        documentStore.add(parsedDocument);
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
