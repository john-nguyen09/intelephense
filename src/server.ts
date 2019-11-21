/* Copyright (c) Ben Robert Mewburn 
 * Licensed under the ISC Licence.
 */
'use strict';

import {
	createConnection, TextDocumentSyncKind,
	InitializeResult, Disposable, DocumentRangeFormattingRequest,
	DocumentSelector,
	InitializeParams
} from 'vscode-languageserver';

import { Intelephense, IntelephenseConfig } from './intelephense';
import { Log } from './logger';
import * as fs from 'fs';

// Create a connection for the server. The connection uses Node's IPC as a transport
const connection = createConnection();
Log.console = connection.console;

process.on('uncaughtException', function (err) {
	Log.writeLog((new Date).toISOString() + ' uncaughtException:' + err.message);
	Log.writeLog(err.stack);
	process.exit(1);
});

const languageId = 'php';

interface VscodeConfig extends IntelephenseConfig {
	formatProvider: { enable: boolean }
}

let config: VscodeConfig = {
	debug: {
		enable: false
	},
	completionProvider: {
		maxItems: 100,
		addUseDeclaration: true,
		backslashPrefix: false
	},
	diagnosticsProvider: {
		debounce: 1000,
		maxItems: 100
	},
	formatProvider: {
		enable: true
	}
};


connection.onInitialize(async (params: InitializeParams): Promise<InitializeResult> => {
	const _ = await Intelephense.initialise(params);
	Intelephense.onPublishDiagnostics((args) => {
		connection.sendDiagnostics(args);
	});
	return <InitializeResult>{
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			documentSymbolProvider: true,
			workspaceSymbolProvider: true,
			completionProvider: {
				triggerCharacters: [
					'$', '>', ':',
					'.', '<', '/' //html/js
				]
			},
			signatureHelpProvider: {
				triggerCharacters: ['(', ',']
			},
			definitionProvider: true,
			//documentFormattingProvider: true,
			documentRangeFormattingProvider: false,
			referencesProvider: true,
			documentLinkProvider: { resolveProvider: false },
			hoverProvider: true,
			documentHighlightProvider: true
		}
	};

});

let docFormatRegister: Thenable<Disposable> = null;

connection.onDidChangeConfiguration((params) => {

	let settings = params.settings.intelephense as VscodeConfig;
	if (!settings) {
		return;
	}
	config = settings;
	Intelephense.setConfig(config);

	let enableFormatter = config.formatProvider && config.formatProvider.enable;
	if (enableFormatter) {
		let documentSelector: DocumentSelector = [{ language: languageId, scheme: 'file' }];
		if (!docFormatRegister) {
			docFormatRegister = connection.client.register(DocumentRangeFormattingRequest.type, { documentSelector });
		}
	} else {
		if (docFormatRegister) {
			docFormatRegister.then(r => r.dispose());
			docFormatRegister = null;
		}
	}

});

//atm for html compatibility
connection.onDocumentLinks((params) => {
	return [];
});

connection.onHover((params) => {
	return Intelephense.provideHover(params.textDocument.uri, params.position);
});

connection.onDocumentHighlight((params) => {
	return Intelephense.provideHighlights(params.textDocument.uri, params.position);
})

connection.onDidOpenTextDocument((params) => {		
	Intelephense.openDocument(params.textDocument);
});

connection.onDidChangeTextDocument((params) => {
	Intelephense.editDocument(params.textDocument, params.contentChanges);
});

connection.onDidCloseTextDocument((params) => {
	Intelephense.closeDocument(params.textDocument);
});

connection.onDocumentSymbol((params) => {
	return Intelephense.documentSymbols(params.textDocument);
});

connection.onWorkspaceSymbol((params) => {
	return Intelephense.workspaceSymbols(params.query);
});

connection.onReferences((params) => {
	return Intelephense.provideReferences(params.textDocument, params.position, params.context);
});

connection.onCompletion((params) => {
	return Intelephense.provideCompletions(params.textDocument, params.position);
});

connection.onSignatureHelp((params) => {
	return Intelephense.provideSignatureHelp(params.textDocument, params.position);
});

connection.onDefinition((params) => {
	return Intelephense.provideDefinition(params.textDocument, params.position);
});

connection.onDocumentRangeFormatting((params) => {
	return Intelephense.provideDocumentRangeFormattingEdits(params.textDocument, params.range, params.options);
});

connection.onShutdown(Intelephense.shutdown);

// Listen on the connection
connection.listen();
