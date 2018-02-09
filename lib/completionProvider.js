/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const symbol_1 = require("./symbol");
const symbolReader_1 = require("./symbolReader");
const typeString_1 = require("./typeString");
const parsedDocument_1 = require("./parsedDocument");
const parseTreeTraverser_1 = require("./parseTreeTraverser");
const lsp = require("vscode-languageserver-types");
const util = require("./util");
const typeAggregate_1 = require("./typeAggregate");
const useDeclarationHelper_1 = require("./useDeclarationHelper");
const noCompletionResponse = {
    items: [],
    isIncomplete: false
};
function keywordCompletionItems(keywords, text) {
    let kw;
    let items = [];
    for (let n = 0, l = keywords.length; n < l; ++n) {
        kw = keywords[n];
        if (util.ciStringContains(text, kw)) {
            items.push({
                label: kw,
                kind: lsp.CompletionItemKind.Keyword
            });
        }
    }
    return items;
}
function symbolKindToLspSymbolKind(kind) {
    switch (kind) {
        case 1 /* Class */:
        case 4 /* Trait */:
            return lsp.CompletionItemKind.Class;
        case 64 /* Function */:
            return lsp.CompletionItemKind.Function;
        case 32 /* Method */:
            return lsp.CompletionItemKind.Method;
        case 8 /* Constant */:
        case 1024 /* ClassConstant */:
            return lsp.CompletionItemKind.Value;
        case 2 /* Interface */:
            return lsp.CompletionItemKind.Interface;
        case 512 /* Namespace */:
            return lsp.CompletionItemKind.Module;
        case 2048 /* Constructor */:
            return lsp.CompletionItemKind.Constructor;
        case 16 /* Property */:
            return lsp.CompletionItemKind.Property;
        case 128 /* Parameter */:
        case 256 /* Variable */:
            return lsp.CompletionItemKind.Variable;
        case 4096 /* File */:
            return lsp.CompletionItemKind.File;
        default:
            return lsp.SymbolKind.String;
    }
}
const defaultCompletionOptions = {
    maxItems: 100,
    addUseDeclaration: true,
    backslashPrefix: true
};
const triggerParameterHintsCommand = {
    title: 'Trigger Parameter Hints',
    command: 'editor.action.triggerParameterHints'
};
class CompletionProvider {
    constructor(symbolStore, documentStore, refStore, config) {
        this.symbolStore = symbolStore;
        this.documentStore = documentStore;
        this.refStore = refStore;
        this._config = config ? config : CompletionProvider._defaultConfig;
        this._strategies = [
            new ClassTypeDesignatorCompletion(this._config, this.symbolStore),
            new ScopedAccessCompletion(this._config, this.symbolStore),
            new ObjectAccessCompletion(this._config, this.symbolStore),
            new SimpleVariableCompletion(this._config, this.symbolStore),
            new TypeDeclarationCompletion(this._config, this.symbolStore),
            new ClassBaseClauseCompletion(this._config, this.symbolStore),
            new InterfaceClauseCompletion(this._config, this.symbolStore),
            new TraitUseClauseCompletion(this._config, this.symbolStore),
            new NamespaceDefinitionCompletion(this._config, this.symbolStore),
            new NamespaceUseClauseCompletion(this._config, this.symbolStore),
            new NamespaceUseGroupClauseCompletion(this._config, this.symbolStore),
            new MethodDeclarationHeaderCompletion(this._config, this.symbolStore),
            new DeclarationBodyCompletion(this._config),
            new InstanceOfTypeDesignatorCompletion(this._config, this.symbolStore),
            new NameCompletion(this._config, this.symbolStore)
        ];
    }
    set config(config) {
        this._config = config;
        for (let n = 0, l = this._strategies.length; n < l; ++n) {
            this._strategies[n].config = config;
        }
    }
    provideCompletions(uri, position) {
        let doc = this.documentStore.find(uri);
        let table = this.symbolStore.getSymbolTable(uri);
        let refTable = this.refStore.getReferenceTable(uri);
        if (!doc || !table || !refTable) {
            return noCompletionResponse;
        }
        let traverser = new parseTreeTraverser_1.ParseTreeTraverser(doc, table, refTable);
        traverser.position(position);
        //return early if not in <?php ?>
        let t = traverser.node;
        if (!t || t.tokenType === 81 /* Text */) {
            return noCompletionResponse;
        }
        let offset = doc.offsetAtPosition(position);
        let word = doc.wordAtOffset(offset);
        let strategy = null;
        for (let n = 0, l = this._strategies.length; n < l; ++n) {
            if (this._strategies[n].canSuggest(traverser.clone())) {
                strategy = this._strategies[n];
                break;
            }
        }
        return strategy ? strategy.completions(traverser, word, doc.lineSubstring(offset)) : noCompletionResponse;
    }
}
CompletionProvider._defaultConfig = defaultCompletionOptions;
exports.CompletionProvider = CompletionProvider;
class AbstractNameCompletion {
    constructor(config, symbolStore) {
        this.config = config;
        this.symbolStore = symbolStore;
    }
    /**
     * Child classes should override but call this first.
     * It moves the traverser to previous token if the current token is a backslash.
     * This corrects for errors when a name has a trailing backslash.
     * @param traverser
     */
    canSuggest(traverser) {
        if (parsedDocument_1.ParsedDocument.isToken(traverser.node, [147 /* Backslash */])) {
            traverser.prevToken();
        }
        return true;
    }
    completions(traverser, word, lineSubstring) {
        let items = [];
        let namePhrase = traverser.clone().ancestor(this._isNamePhrase);
        let nameResolver = traverser.nameResolver;
        if (!word || !namePhrase) {
            return noCompletionResponse;
        }
        let pred = this._symbolFilter;
        let addUseDeclarationEnabled = this.config.addUseDeclaration;
        let fqnOffset = 0;
        let isUnqualified = false;
        const useDeclarationHelper = new useDeclarationHelper_1.UseDeclarationHelper(traverser.document, traverser.symbolTable, traverser.range.start);
        const importMap = {};
        let qualifiedNameRule;
        if (namePhrase.phraseType === 144 /* RelativeQualifiedName */ ||
            namePhrase.phraseType === 84 /* FullyQualifiedName */ ||
            word.indexOf('\\') > -1) {
            //If the user has started typing a RelativeQualifiedName, FullyQualifiedName,
            //or a QualifiedName with an ns separator then it is asumed they must 
            //intend to have an expanded name with no use declaration.
            //Allow namespaces in this case to enable progresive discovery of symbols.
            //Expand word to match start of symbol fqn
            if (namePhrase.phraseType === 144 /* RelativeQualifiedName */) {
                //symbols share current namespace
                word = nameResolver.resolveRelative(word.slice(10)); //namespace\
            }
            else if (namePhrase.phraseType === 141 /* QualifiedName */) {
                qualifiedNameRule = nameResolver.matchImportedSymbol(word.slice(0, word.indexOf('\\')), 1 /* Class */);
                word = nameResolver.resolveNotFullyQualified(word);
            }
            addUseDeclarationEnabled = false;
            fqnOffset = word.lastIndexOf('\\') + 1;
        }
        else {
            //QualifiedName with no ns separator (unqualified)
            //It is assumed that the user is wanting to match the non fqn name,  
            //a keyword, or an existing use declaration.
            //Only allow namespace if in global namespace.
            isUnqualified = true;
            const sf = pred;
            const isGlobalNs = nameResolver.namespaceName.length > 0;
            pred = x => {
                return sf(x) &&
                    (isGlobalNs || x.kind !== 512 /* Namespace */) &&
                    (x.kind === 512 /* Namespace */ || util.ciStringContains(word, symbol_1.PhpSymbol.notFqn(x.name)));
            };
            Array.prototype.push.apply(items, keywordCompletionItems(this._getKeywords(traverser.clone()), word));
            const imports = this._importedSymbols(nameResolver.rules, this._symbolFilter, word);
            let imported;
            for (let n = 0; n < imports.length; ++n) {
                imported = imports[n];
                if (imported.associated && imported.associated.length) {
                    importMap[imported.associated[0].name] = imported;
                }
                items.push(this._toCompletionItem(imports[n], useDeclarationHelper, nameResolver.namespaceName, isUnqualified, fqnOffset, qualifiedNameRule));
            }
        }
        const uniqueSymbols = new symbol_1.UniqueSymbolSet();
        const iterator = this.symbolStore.matchIterator(word, pred);
        let limit = this.config.maxItems;
        let isIncomplete = false;
        for (let s of iterator) {
            if (importMap[s.name] || uniqueSymbols.has(s)) {
                continue;
            }
            uniqueSymbols.add(s);
            items.push(this._toCompletionItem(s, useDeclarationHelper, nameResolver.namespaceName, isUnqualified, fqnOffset, qualifiedNameRule));
            if (items.length >= limit) {
                isIncomplete = true;
                break;
            }
        }
        return {
            items: items,
            isIncomplete: isIncomplete
        };
    }
    /**
     * Not used for now because the parser will put this trailing backslash into
     * a subsequent node
     *
     *
     * If triggered on an incomplete name with a trailing backslash,
     * the backslash will not be present in the name node because of parse error.
     * In this case, traverse to previous token and test if in name.
     * @param traverser
     */
    _isNameWithTrailingBackslash(traverser) {
        let node = traverser.node;
        if (!parsedDocument_1.ParsedDocument.isToken(node, [147 /* Backslash */])) {
            return false;
        }
        traverser = traverser.clone();
        return parsedDocument_1.ParsedDocument.isToken(traverser.prevToken(), [83 /* Name */]) &&
            traverser.ancestor(this._isNamePhrase);
    }
    _useSymbolToUseDeclaration(s) {
        const fqn = s.associated[0].name;
        let decl = `use ${fqn}`;
        const slashPos = fqn.lastIndexOf('\\') + 1;
        if (fqn.slice(-s.name.length) !== s.name) {
            //aliased
            decl += ` as ${s.name}`;
        }
        return decl;
    }
    _importedSymbols(rules, pred, text) {
        let filteredRules = [];
        let r;
        for (let n = 0, l = rules.length; n < l; ++n) {
            r = rules[n];
            if (r.associated && r.associated.length > 0 && util.ciStringContains(text, r.name)) {
                filteredRules.push(r);
            }
        }
        //lookup associated symbol for extra info
        let s;
        let merged;
        let imported = [];
        for (let n = 0, l = filteredRules.length; n < l; ++n) {
            r = filteredRules[n];
            s = this.symbolStore.find(r.associated[0].name, pred).shift();
            if (s) {
                merged = symbol_1.PhpSymbol.clone(s);
                merged.associated = r.associated;
                merged.modifiers |= 4096 /* Use */;
                merged.name = r.name;
                imported.push(merged);
            }
            else {
                //not found but suggest it anyway as a namespace
                merged = symbol_1.PhpSymbol.clone(r);
                merged.kind = 512 /* Namespace */;
                imported.push(merged);
            }
        }
        return imported;
    }
    _toCompletionItem(s, useDeclarationHelper, namespaceName, isUnqualified, fqnOffset, qualifiedNameRule) {
        const item = {
            kind: symbolKindToLspSymbolKind(s.kind),
            label: undefined
        };
        //todo remove this and use resolve provider
        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }
        const symbolNamespace = symbol_1.PhpSymbol.namespace(s.name);
        if (!isUnqualified) {
            item.label = s.name.slice(fqnOffset);
            if (qualifiedNameRule) {
                item.detail = this._useSymbolToUseDeclaration(qualifiedNameRule);
            }
        }
        else if ((s.modifiers & 4096 /* Use */) > 0) {
            //symbol is use decl
            //show the use decl as detail
            item.detail = this._useSymbolToUseDeclaration(s);
            item.label = symbol_1.PhpSymbol.notFqn(s.name);
        }
        else if (s.kind === 512 /* Namespace */ || (!namespaceName && !symbolNamespace) || (s.kind === 8 /* Constant */ && this._isMagicConstant(s.name))) {
            //symbols not namespaced and in global namespace context
            //and unqualified namespaces
            //and php magic constants
            //get fqn only
            item.label = s.name;
        }
        else if (namespaceName === symbolNamespace) {
            //symbol shares same namespace 
            //show the current namespace
            item.detail = `namespace ${namespaceName}`;
            item.label = symbol_1.PhpSymbol.notFqn(s.name);
        }
        else if (namespaceName && !symbolNamespace) {
            //symbol is in global namespace but the current namespace is not global
            //prefix with backslash
            //functions and const dont need prefix unless set in config
            item.label = s.name;
            if ((s.kind !== 8 /* Constant */ && s.kind !== 64 /* Function */) || this.config.backslashPrefix) {
                item.insertText = '\\' + s.name;
            }
        }
        else if (this.config.addUseDeclaration && !useDeclarationHelper.findUseSymbolByName(s.name)) {
            //match on short name
            //add a use decl as additional text
            item.label = symbol_1.PhpSymbol.notFqn(s.name);
            item.detail = `use ${s.name}`;
            item.additionalTextEdits = [useDeclarationHelper.insertDeclarationTextEdit(s)];
        }
        else {
            //insert fqn
            item.insertText = '\\' + s.name;
            item.detail = s.name;
        }
        if (s.kind === 64 /* Function */) {
            if (!item.insertText) {
                item.insertText = item.label;
            }
            //add signature
            //and configure to invoke parameter hints
            item.detail = s.name + symbol_1.PhpSymbol.signatureString(s);
            if (symbol_1.PhpSymbol.hasParameters(s)) {
                item.insertText += '($0)';
                item.insertTextFormat = lsp.InsertTextFormat.Snippet;
                item.command = triggerParameterHintsCommand;
            }
            else {
                item.insertText += '()';
            }
        }
        else if (s.kind === 8 /* Constant */) {
            if (s.value) {
                item.detail = `${s.name} = ${s.value}`;
            }
        }
        else {
            //class, interface, trait
        }
        return item;
    }
    _isMagicConstant(text) {
        switch (text) {
            case '__DIR__':
            case '__FILE__':
            case '__CLASS__':
            case '__LINE__':
            case '__FUNCTION__':
            case '__TRAIT__':
            case '__METHOD__':
            case '__NAMESPACE__':
                return true;
            default:
                return false;
        }
    }
    _isNamePhrase(node) {
        switch (node.phraseType) {
            case 141 /* QualifiedName */:
            case 84 /* FullyQualifiedName */:
            case 144 /* RelativeQualifiedName */:
                return true;
            default:
                return false;
        }
    }
    _mergeSymbols(matches, imports) {
        let merged = imports.slice(0);
        let map = {};
        let imported;
        let s;
        for (let n = 0, l = imports.length; n < l; ++n) {
            imported = imports[n];
            if (imported.associated && imported.associated.length) {
                map[imported.associated[0].name] = imported;
            }
        }
        for (let n = 0, l = matches.length; n < l; ++n) {
            s = matches[n];
            imported = map[s.name];
            if (!imported) {
                merged.push(s);
            }
        }
        return merged;
    }
}
class InstanceOfTypeDesignatorCompletion extends AbstractNameCompletion {
    canSuggest(traverser) {
        super.canSuggest(traverser);
        return parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [121 /* NamespaceName */]) &&
            parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [84 /* FullyQualifiedName */, 141 /* QualifiedName */, 144 /* RelativeQualifiedName */]) &&
            parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [101 /* InstanceofTypeDesignator */]);
    }
    _symbolFilter(s) {
        return (s.kind & (1 /* Class */ | 2 /* Interface */ | 512 /* Namespace */)) > 0 && !(s.modifiers & (512 /* Anonymous */));
    }
    _getKeywords(traverser) {
        return [];
    }
}
class ClassTypeDesignatorCompletion extends AbstractNameCompletion {
    canSuggest(traverser) {
        super.canSuggest(traverser);
        return parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [121 /* NamespaceName */]) &&
            parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [84 /* FullyQualifiedName */, 141 /* QualifiedName */, 144 /* RelativeQualifiedName */]) &&
            parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [34 /* ClassTypeDesignator */]);
    }
    _symbolFilter(s) {
        return (s.kind & (1 /* Class */ | 512 /* Namespace */)) > 0 &&
            !(s.modifiers & (512 /* Anonymous */ | 16 /* Abstract */));
    }
    _getKeywords(traverser) {
        if (traverser.ancestor(this._isQualifiedName)) {
            return ClassTypeDesignatorCompletion._keywords;
        }
        return [];
    }
    _toCompletionItem(s, useDeclarationHelper, namespaceName, isUnqualified, fqnOffset, qualifiedNameRule) {
        let item = super._toCompletionItem(s, useDeclarationHelper, namespaceName, isUnqualified, fqnOffset, qualifiedNameRule);
        let aggregate = new typeAggregate_1.TypeAggregate(this.symbolStore, s);
        let constructor = aggregate.firstMember(this._isConstructor);
        item.kind = lsp.CompletionItemKind.Constructor;
        if (constructor && symbol_1.PhpSymbol.hasParameters(constructor)) {
            if (!item.insertText) {
                item.insertText = item.label;
            }
            item.insertText += '($0)';
            item.detail = constructor.name + symbol_1.PhpSymbol.signatureString(constructor);
            item.insertTextFormat = lsp.InsertTextFormat.Snippet;
            item.command = triggerParameterHintsCommand;
        }
        return item;
    }
    _isConstructor(s) {
        return s.kind === 2048 /* Constructor */ || (s.kind === 32 /* Method */ && s.name.toLowerCase() === '__construct');
    }
    _isQualifiedName(node) {
        return node.phraseType === 141 /* QualifiedName */;
    }
}
ClassTypeDesignatorCompletion._keywords = [
    'class', 'static', 'namespace'
];
class SimpleVariableCompletion {
    constructor(config, symbolStore) {
        this.config = config;
        this.symbolStore = symbolStore;
    }
    canSuggest(traverser) {
        return parsedDocument_1.ParsedDocument.isToken(traverser.node, [90 /* Dollar */, 84 /* VariableName */]) &&
            parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [156 /* SimpleVariable */]);
    }
    completions(traverser, word, lineSubstring) {
        if (!word) {
            return noCompletionResponse;
        }
        let scope = traverser.scope;
        let symbolMask = 256 /* Variable */ | 128 /* Parameter */;
        let varSymbols = symbol_1.PhpSymbol.filterChildren(scope, (x) => {
            return (x.kind & symbolMask) > 0 && x.name.indexOf(word) === 0;
        });
        //also suggest built in globals vars
        Array.prototype.push.apply(varSymbols, this.symbolStore.match(word, this._isBuiltInGlobalVar));
        let limit = Math.min(varSymbols.length, this.config.maxItems);
        let isIncomplete = varSymbols.length > this.config.maxItems;
        let items = [];
        let refScope = traverser.refTable.scopeAtPosition(scope.location.range.start);
        let varTable = this._varTypeMap(refScope);
        for (let n = 0; n < limit; ++n) {
            items.push(this._toVariableCompletionItem(varSymbols[n], varTable));
        }
        return {
            items: items,
            isIncomplete: isIncomplete
        };
    }
    _toVariableCompletionItem(s, varTable) {
        let item = {
            label: s.name.slice(1),
            kind: lsp.CompletionItemKind.Variable,
            detail: varTable[s.name] || ''
        };
        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }
        return item;
    }
    _varTypeMap(s) {
        let map = {};
        if (!s || !s.children) {
            return {};
        }
        let ref;
        for (let n = 0, l = s.children.length; n < l; ++n) {
            ref = s.children[n];
            if (ref.kind === 256 /* Variable */ || ref.kind === 128 /* Parameter */) {
                map[ref.name] = typeString_1.TypeString.merge(map[ref.name], ref.type);
            }
        }
        return map;
    }
    _isBuiltInGlobalVar(s) {
        return s.kind === 256 /* Variable */ && !s.location;
    }
}
class NameCompletion extends AbstractNameCompletion {
    canSuggest(traverser) {
        super.canSuggest(traverser);
        return parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [121 /* NamespaceName */]) &&
            traverser.ancestor(this._isNamePhrase) !== undefined;
    }
    completions(traverser, word, lineSubstring) {
        //<?php (no trailing space) is considered short tag open and then name token
        //dont suggest in this context
        if (lineSubstring.slice(-3) === '<?p' ||
            lineSubstring.slice(-4) === '<?ph' ||
            lineSubstring.slice(-5) === '<?php') {
            return NameCompletion._openTagCompletion;
        }
        //this strategy may get called during parse errors on class/interface declaration
        //when wanting to use extends/implements.
        //suppress name suggestions in this case
        if (lineSubstring.match(NameCompletion._extendsOrImplementsRegexRegex)) {
            return lsp.CompletionList.create([
                { kind: lsp.CompletionItemKind.Keyword, label: 'extends' },
                { kind: lsp.CompletionItemKind.Keyword, label: 'implements' }
            ]);
        }
        if (lineSubstring.match(NameCompletion._implementsRegex)) {
            return lsp.CompletionList.create([{ kind: lsp.CompletionItemKind.Keyword, label: 'implements' }]);
        }
        return super.completions(traverser, word, lineSubstring);
    }
    _getKeywords(traverser) {
        let kw = [];
        Array.prototype.push.apply(kw, NameCompletion._expressionKeywords);
        Array.prototype.push.apply(kw, NameCompletion._statementKeywords);
        return kw;
    }
    _symbolFilter(s) {
        return (s.kind & (1 /* Class */ | 64 /* Function */ | 8 /* Constant */ | 512 /* Namespace */)) > 0 &&
            !(s.modifiers & 512 /* Anonymous */);
    }
}
NameCompletion._statementKeywords = [
    '__halt_compiler',
    'abstract',
    'break',
    'case',
    'catch',
    'class',
    'const',
    'continue',
    'declare',
    'default',
    'die',
    'do',
    'echo',
    'else',
    'elseif',
    'enddeclare',
    'endfor',
    'endforeach',
    'endif',
    'endswitch',
    'endwhile',
    'final',
    'finally',
    'for',
    'foreach',
    'function',
    'global',
    'goto',
    'if',
    'interface',
    'list',
    'namespace',
    'return',
    'static',
    'switch',
    'throw',
    'trait',
    'try',
    'unset',
    'use',
    'while'
];
NameCompletion._expressionKeywords = [
    'array',
    'clone',
    'empty',
    'eval',
    'exit',
    'function',
    'include',
    'include_once',
    'isset',
    'new',
    'parent',
    'print',
    'require',
    'require_once',
    'static',
    'yield',
    'as',
    'self'
];
NameCompletion._openTagCompletion = {
    isIncomplete: false,
    items: [{
            kind: lsp.CompletionItemKind.Keyword,
            label: '<?php',
            insertText: 'php'
        }]
};
NameCompletion._extendsOrImplementsRegexRegex = /\b(?:class|interface)\s+[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*\s+[a-z]+$/;
NameCompletion._implementsRegex = /\bclass\s+[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*(?:\s+extends\s+[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*)?\s+[a-z]+$/;
class MemberAccessCompletion {
    constructor(config, symbolStore) {
        this.config = config;
        this.symbolStore = symbolStore;
    }
    completions(traverser, word) {
        let scopedAccessExpr = traverser.ancestor(this._isMemberAccessExpr);
        let scopePhrase = traverser.nthChild(0);
        let type = this._resolveType(traverser);
        let typeNames = typeString_1.TypeString.atomicClassArray(type);
        if (!typeNames.length) {
            return noCompletionResponse;
        }
        let nameResolver = traverser.nameResolver;
        let classAggregateType = typeAggregate_1.TypeAggregate.create(this.symbolStore, nameResolver.className);
        let typeName;
        let fn;
        let typeAggregate;
        let symbols = [];
        for (let n = 0, l = typeNames.length; n < l; ++n) {
            typeName = typeNames[n];
            if (classAggregateType && classAggregateType.name.toLowerCase() === typeName.toLowerCase()) {
                typeAggregate = classAggregateType;
            }
            else {
                typeAggregate = typeAggregate_1.TypeAggregate.create(this.symbolStore, typeName);
            }
            if (!typeAggregate) {
                continue;
            }
            fn = this._createMemberPredicate(typeName, word, classAggregateType);
            Array.prototype.push.apply(symbols, typeAggregate.members(2 /* Documented */, fn));
        }
        symbols = Array.from(new Set(symbols)); //unique
        let isIncomplete = symbols.length > this.config.maxItems;
        let limit = Math.min(symbols.length, this.config.maxItems);
        let items = [];
        for (let n = 0; n < limit; ++n) {
            items.push(this._toCompletionItem(symbols[n]));
        }
        return {
            isIncomplete: isIncomplete,
            items: items
        };
    }
    _resolveType(traverser) {
        //assumed that traverser is on the member scope node
        let node;
        let arrayDereference = 0;
        let ref;
        while (true) {
            node = traverser.node;
            switch (node.phraseType) {
                case 84 /* FullyQualifiedName */:
                case 144 /* RelativeQualifiedName */:
                case 141 /* QualifiedName */:
                case 156 /* SimpleVariable */:
                case 145 /* RelativeScope */:
                    ref = traverser.reference;
                    break;
                case 112 /* MethodCallExpression */:
                case 136 /* PropertyAccessExpression */:
                case 150 /* ScopedCallExpression */:
                case 152 /* ScopedPropertyAccessExpression */:
                case 24 /* ClassConstantAccessExpression */:
                    if (traverser.child(this._isMemberName)) {
                        ref = traverser.reference;
                    }
                    break;
                case 56 /* EncapsulatedExpression */:
                    if (traverser.child(parsedDocument_1.ParsedDocument.isPhrase)) {
                        continue;
                    }
                    break;
                case 128 /* ObjectCreationExpression */:
                    if (traverser.child(this._isClassTypeDesignator) && traverser.child(parsedDocument_1.ParsedDocument.isNamePhrase)) {
                        ref = traverser.reference;
                    }
                    break;
                case 155 /* SimpleAssignmentExpression */:
                case 16 /* ByRefAssignmentExpression */:
                    if (traverser.nthChild(0)) {
                        continue;
                    }
                    break;
                case 85 /* FunctionCallExpression */:
                    if (traverser.nthChild(0)) {
                        ref = traverser.reference;
                    }
                    break;
                case 160 /* SubscriptExpression */:
                    if (traverser.nthChild(0)) {
                        arrayDereference++;
                        continue;
                    }
                    break;
                default:
                    break;
            }
            break;
        }
        if (!ref) {
            return '';
        }
        let type = this.symbolStore.referenceToTypeString(ref);
        while (arrayDereference--) {
            type = typeString_1.TypeString.arrayDereference(type);
        }
        return type;
    }
    _isMemberAccessExpr(node) {
        switch (node.phraseType) {
            case 150 /* ScopedCallExpression */:
            case 65 /* ErrorScopedAccessExpression */:
            case 24 /* ClassConstantAccessExpression */:
            case 152 /* ScopedPropertyAccessExpression */:
            case 136 /* PropertyAccessExpression */:
            case 112 /* MethodCallExpression */:
                return true;
            default:
                return false;
        }
    }
    _toCompletionItem(s) {
        switch (s.kind) {
            case 1024 /* ClassConstant */:
                return this.toClassConstantCompletionItem(s);
            case 32 /* Method */:
                return this.toMethodCompletionItem(s);
            case 16 /* Property */:
                return this.toPropertyCompletionItem(s);
            default:
                throw Error('Invalid Argument');
        }
    }
    toMethodCompletionItem(s) {
        let item = {
            kind: lsp.CompletionItemKind.Method,
            label: s.name,
            detail: s.name + symbol_1.PhpSymbol.signatureString(s)
        };
        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }
        if (s.name.slice(0, 2) === '__') {
            //sort magic methods last
            item.sortText = 'zzz';
        }
        else {
            //all items must have sortText for comparison to occur in vscode
            item.sortText = item.label;
        }
        if (symbol_1.PhpSymbol.hasParameters(s)) {
            item.insertText = s.name + '($0)';
            item.insertTextFormat = lsp.InsertTextFormat.Snippet;
            item.command = triggerParameterHintsCommand;
        }
        else {
            item.insertText = s.name + '()';
        }
        return item;
    }
    toClassConstantCompletionItem(s) {
        let item = {
            kind: lsp.CompletionItemKind.Value,
            label: s.name,
        };
        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }
        if (s.value) {
            item.detail = `${s.name} = ${s.value}`;
        }
        return item;
    }
    toPropertyCompletionItem(s) {
        let item = {
            kind: lsp.CompletionItemKind.Property,
            label: s.name.slice(1),
            detail: symbol_1.PhpSymbol.type(s)
        };
        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }
        return item;
    }
    _isMemberName(node) {
        return node.phraseType === 111 /* MemberName */ || node.phraseType === 151 /* ScopedMemberName */;
    }
    _isClassTypeDesignator(node) {
        return node.phraseType === 34 /* ClassTypeDesignator */;
    }
}
class ScopedAccessCompletion extends MemberAccessCompletion {
    canSuggest(traverser) {
        const scopedAccessPhrases = [
            150 /* ScopedCallExpression */,
            65 /* ErrorScopedAccessExpression */,
            24 /* ClassConstantAccessExpression */,
            152 /* ScopedPropertyAccessExpression */
        ];
        if (parsedDocument_1.ParsedDocument.isToken(traverser.node, [133 /* ColonColon */])) {
            return parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), scopedAccessPhrases);
        }
        if (parsedDocument_1.ParsedDocument.isToken(traverser.node, [84 /* VariableName */])) {
            return parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [151 /* ScopedMemberName */]);
        }
        if (parsedDocument_1.ParsedDocument.isToken(traverser.node, [90 /* Dollar */])) {
            return parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [156 /* SimpleVariable */]) &&
                parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [151 /* ScopedMemberName */]);
        }
        return parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [95 /* Identifier */]) &&
            parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [151 /* ScopedMemberName */]);
    }
    _createMemberPredicate(scopeName, word, classContext) {
        if (classContext && scopeName.toLowerCase() === classContext.name.toLowerCase()) {
            //public, protected, private
            return (x) => {
                return (x.modifiers & 32 /* Static */) > 0 && util.ciStringContains(word, x.name);
            };
        }
        else if (classContext && classContext.isBaseClass(scopeName)) {
            //public, protected
            //looking for non static here as well to handle parent keyword
            return (x) => {
                return !(x.modifiers & 4 /* Private */) && util.ciStringContains(word, x.name);
            };
        }
        else if (classContext && classContext.isAssociated(scopeName)) {
            //public, protected
            return (x) => {
                return (x.modifiers & 32 /* Static */) > 0 &&
                    !(x.modifiers & 4 /* Private */) &&
                    util.ciStringContains(word, x.name);
            };
        }
        else {
            //public
            const mask = 32 /* Static */ | 1 /* Public */;
            return (x) => {
                return (x.modifiers & mask) === mask && util.ciStringContains(word, x.name);
            };
        }
    }
}
class ObjectAccessCompletion extends MemberAccessCompletion {
    canSuggest(traverser) {
        if (parsedDocument_1.ParsedDocument.isToken(traverser.node, [115 /* Arrow */])) {
            return parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [136 /* PropertyAccessExpression */, 112 /* MethodCallExpression */]);
        }
        return parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [111 /* MemberName */]);
    }
    _createMemberPredicate(scopeName, word, classContext) {
        //php allows static methods to be accessed with ->
        if (classContext && scopeName.toLowerCase() === classContext.name.toLowerCase()) {
            //public, protected, private
            return (x) => {
                return util.ciStringContains(word, x.name);
            };
        }
        else if (classContext && classContext.isAssociated(scopeName)) {
            //public, protected
            const mask = 4 /* Private */;
            return (x) => {
                return !(x.modifiers & mask) && util.ciStringContains(word, x.name);
            };
        }
        else {
            //public
            const mask = 2 /* Protected */ | 4 /* Private */;
            return (x) => {
                return !(x.modifiers & mask) && util.ciStringContains(word, x.name);
            };
        }
    }
}
class TypeDeclarationCompletion extends AbstractNameCompletion {
    canSuggest(traverser) {
        super.canSuggest(traverser);
        return parsedDocument_1.ParsedDocument.isToken(traverser.node, [83 /* Name */, 147 /* Backslash */, 3 /* Array */, 6 /* Callable */]) &&
            traverser.ancestor(this._isTypeDeclaration) !== undefined;
    }
    _getKeywords(traverser) {
        return TypeDeclarationCompletion._keywords;
    }
    _symbolFilter(s) {
        return (s.kind & (1 /* Class */ | 2 /* Interface */ | 512 /* Namespace */)) > 0;
    }
    _isTypeDeclaration(node) {
        return node.phraseType === 173 /* TypeDeclaration */;
    }
}
TypeDeclarationCompletion._keywords = [
    'self', 'array', 'callable', 'bool', 'float', 'int', 'string'
];
class ClassBaseClauseCompletion extends AbstractNameCompletion {
    canSuggest(traverser) {
        super.canSuggest(traverser);
        return traverser.ancestor(this._isClassBaseClause) !== undefined;
    }
    _getKeywords(traverser) {
        return [];
    }
    _symbolFilter(s) {
        return (s.kind & (1 /* Class */ | 512 /* Namespace */)) > 0 && !(s.modifiers & 8 /* Final */);
    }
    _isClassBaseClause(node) {
        return node.phraseType === 23 /* ClassBaseClause */;
    }
}
class InterfaceClauseCompletion extends AbstractNameCompletion {
    canSuggest(traverser) {
        super.canSuggest(traverser);
        return traverser.ancestor(this._isInterfaceClause) !== undefined;
    }
    _getKeywords(traverser) {
        return [];
    }
    _symbolFilter(s) {
        return s.kind === 2 /* Interface */ || s.kind === 512 /* Namespace */;
    }
    _isInterfaceClause(node) {
        return node.phraseType === 31 /* ClassInterfaceClause */ ||
            node.phraseType === 102 /* InterfaceBaseClause */;
    }
}
class TraitUseClauseCompletion extends AbstractNameCompletion {
    canSuggest(traverser) {
        super.canSuggest(traverser);
        return traverser.ancestor(this._isNamePhrase) &&
            parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [142 /* QualifiedNameList */]) &&
            parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [170 /* TraitUseClause */]);
    }
    _getKeywords(traverser) {
        return [];
    }
    _symbolFilter(s) {
        return s.kind === 4 /* Trait */ || s.kind === 512 /* Namespace */;
    }
}
class NamespaceDefinitionCompletion {
    constructor(config, symbolStore) {
        this.config = config;
        this.symbolStore = symbolStore;
    }
    canSuggest(traverser) {
        return traverser.ancestor(this._isNamespaceDefinition) !== undefined;
    }
    completions(traverser, word) {
        const items = [];
        const uniqueSymbols = new symbol_1.UniqueSymbolSet();
        //namespaces always match on fqn
        const matches = this.symbolStore.matchIterator(word, this._symbolFilter);
        let isIncomplete = false;
        let n = this.config.maxItems;
        //replace from the last \
        const fqnOffset = word.lastIndexOf('\\') + 1;
        for (let s of matches) {
            if (uniqueSymbols.has(s)) {
                continue;
            }
            uniqueSymbols.add(s);
            items.push({
                label: s.name.slice(fqnOffset),
                kind: lsp.CompletionItemKind.Module
            });
            --n;
            if (n < 1) {
                isIncomplete = true;
                break;
            }
        }
        return {
            items: items,
            isIncomplete: isIncomplete
        };
    }
    _toNamespaceCompletionItem(s) {
        return {
            label: s.name,
            kind: lsp.CompletionItemKind.Module
        };
    }
    _symbolFilter(s) {
        return s.kind === 512 /* Namespace */;
    }
    _isNamespaceDefinition(node) {
        return node.phraseType === 120 /* NamespaceDefinition */;
    }
}
class NamespaceUseClauseCompletion {
    constructor(config, symbolStore) {
        this.config = config;
        this.symbolStore = symbolStore;
    }
    canSuggest(traverser) {
        if (parsedDocument_1.ParsedDocument.isToken(traverser.node, [147 /* Backslash */])) {
            traverser.prevToken();
        }
        return traverser.ancestor(this._isNamespaceUseClause) !== undefined;
    }
    completions(traverser, word) {
        let items = [];
        let namespaceUseDecl = traverser.ancestor(this._isNamespaceUseDeclaration);
        if (!word) {
            return noCompletionResponse;
        }
        const kindMask = this._modifierToSymbolKind(traverser.child(this._isModifier));
        const pred = (x) => {
            return (x.kind & kindMask) > 0 && !(x.modifiers & 4096 /* Use */);
        };
        const matches = this.symbolStore.matchIterator(word, pred);
        const uniqueSymbols = new symbol_1.UniqueSymbolSet();
        let n = this.config.maxItems;
        let isIncomplete = false;
        //may have matched on fqn or short name 
        const fqnOffset = word.lastIndexOf('\\') + 1;
        const lcWord = word.toLowerCase();
        for (let s of matches) {
            if (uniqueSymbols.has(s)) {
                continue;
            }
            uniqueSymbols.add(s);
            items.push(this._toCompletionItem(s, lcWord, fqnOffset));
            if (--n < 1) {
                isIncomplete = true;
                break;
            }
        }
        return {
            isIncomplete: isIncomplete,
            items: items
        };
    }
    _toCompletionItem(s, lcWord, fqnOffset) {
        const didMatchOnFqn = s.name.slice(0, lcWord.length).toLowerCase() === lcWord;
        let item = {
            kind: symbolKindToLspSymbolKind(s.kind),
            label: didMatchOnFqn ? s.name.slice(fqnOffset) : symbol_1.PhpSymbol.notFqn(s.name)
        };
        if (s.kind !== 512 /* Namespace */ && !didMatchOnFqn) {
            item.detail = s.name;
            item.insertText = s.name;
        }
        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }
        return item;
    }
    _isNamespaceUseDeclaration(node) {
        return node.phraseType === 124 /* NamespaceUseDeclaration */;
    }
    _isNamespaceUseClause(node) {
        return node.phraseType === 122 /* NamespaceUseClause */;
    }
    _modifierToSymbolKind(token) {
        const defaultKindMask = 1 /* Class */ | 2 /* Interface */ | 4 /* Trait */ | 512 /* Namespace */;
        if (!token) {
            return defaultKindMask;
        }
        switch (token.tokenType) {
            case 35 /* Function */:
                return 64 /* Function */ | 512 /* Namespace */;
            case 12 /* Const */:
                return 8 /* Constant */ | 512 /* Namespace */;
            default:
                return defaultKindMask;
        }
    }
    _isModifier(node) {
        switch (node.tokenType) {
            case 9 /* Class */:
            case 35 /* Function */:
            case 12 /* Const */:
                return true;
            default:
                return false;
        }
    }
}
class NamespaceUseGroupClauseCompletion {
    constructor(config, symbolStore) {
        this.config = config;
        this.symbolStore = symbolStore;
    }
    canSuggest(traverser) {
        if (parsedDocument_1.ParsedDocument.isToken(traverser.node, [147 /* Backslash */])) {
            traverser.prevToken();
        }
        return traverser.ancestor(this._isNamespaceUseGroupClause) !== undefined;
    }
    completions(traverser, word) {
        let items = [];
        if (!word) {
            return noCompletionResponse;
        }
        let nsUseGroupClause = traverser.ancestor(this._isNamespaceUseGroupClause);
        let nsUseGroupClauseModifier = traverser.child(this._isModifier);
        let nsUseDecl = traverser.ancestor(this._isNamespaceUseDeclaration);
        let nsUseDeclModifier = traverser.child(this._isModifier);
        let kindMask = this._modifierToSymbolKind(nsUseGroupClauseModifier || nsUseDeclModifier);
        let prefix = '';
        if (nsUseDeclModifier) {
            traverser.parent();
        }
        if (traverser.child(this._isNamespaceName)) {
            prefix = traverser.text;
        }
        word = prefix + '\\' + word;
        let pred = (x) => {
            return (x.kind & kindMask) > 0 && !(x.modifiers & 4096 /* Use */);
        };
        let matches = this.symbolStore.matchIterator(word, pred);
        let uniqueSymbols = new symbol_1.UniqueSymbolSet();
        let isIncomplete = false;
        let n = this.config.maxItems;
        const fqnOffset = word.lastIndexOf('\\') + 1;
        for (let s of matches) {
            if (uniqueSymbols.has(s)) {
                continue;
            }
            uniqueSymbols.add(s);
            items.push(this._toCompletionItem(s, fqnOffset));
            if (--n < 1) {
                isIncomplete = true;
                break;
            }
        }
        return {
            isIncomplete: isIncomplete,
            items: items
        };
    }
    _toCompletionItem(s, fqnOffset) {
        let item = {
            kind: symbolKindToLspSymbolKind(s.kind),
            label: s.name.slice(fqnOffset)
        };
        //todo remove and implement resolve provider
        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }
        return item;
    }
    _isNamespaceUseGroupClause(node) {
        return node.phraseType === 125 /* NamespaceUseGroupClause */;
    }
    _isNamespaceUseDeclaration(node) {
        return node.phraseType === 124 /* NamespaceUseDeclaration */;
    }
    _isModifier(node) {
        switch (node.tokenType) {
            case 9 /* Class */:
            case 35 /* Function */:
            case 12 /* Const */:
                return true;
            default:
                return false;
        }
    }
    _isNamespaceName(node) {
        return node.phraseType === 121 /* NamespaceName */;
    }
    _modifierToSymbolKind(modifier) {
        const defaultKindMask = 1 /* Class */ | 2 /* Interface */ | 4 /* Trait */ | 512 /* Namespace */;
        if (!modifier) {
            return defaultKindMask;
        }
        switch (modifier.tokenType) {
            case 35 /* Function */:
                return 64 /* Function */ | 512 /* Namespace */;
            case 12 /* Const */:
                return 8 /* Constant */ | 512 /* Namespace */;
            default:
                return defaultKindMask;
        }
    }
}
class DeclarationBodyCompletion {
    constructor(config) {
        this.config = config;
    }
    canSuggest(traverser) {
        return parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), DeclarationBodyCompletion._phraseTypes) ||
            (parsedDocument_1.ParsedDocument.isPhrase(traverser.node, [60 /* Error */]) && parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), DeclarationBodyCompletion._phraseTypes));
    }
    completions(traverser, word) {
        return {
            items: keywordCompletionItems(DeclarationBodyCompletion._keywords, word)
        };
    }
}
DeclarationBodyCompletion._phraseTypes = [
    29 /* ClassDeclarationBody */, 104 /* InterfaceDeclarationBody */, 166 /* TraitDeclarationBody */,
    61 /* ErrorClassMemberDeclaration */
];
DeclarationBodyCompletion._keywords = [
    'var', 'public', 'private', 'protected', 'final', 'function', 'abstract', 'implements', 'extends'
];
class MethodDeclarationHeaderCompletion {
    constructor(config, symbolStore) {
        this.config = config;
        this.symbolStore = symbolStore;
    }
    canSuggest(traverser) {
        let nameResolver = traverser.nameResolver;
        let thisSymbol = nameResolver.class;
        return parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [95 /* Identifier */]) &&
            parsedDocument_1.ParsedDocument.isPhrase(traverser.parent(), [115 /* MethodDeclarationHeader */]) &&
            thisSymbol !== undefined && thisSymbol.associated !== undefined && thisSymbol.associated.length > 0;
    }
    completions(traverser, word) {
        let memberDecl = traverser.ancestor(this._isMethodDeclarationHeader);
        let modifiers = symbolReader_1.SymbolReader.modifierListToSymbolModifier(traverser.child(this._isMemberModifierList));
        if (modifiers & (4 /* Private */ | 16 /* Abstract */)) {
            return noCompletionResponse;
        }
        modifiers &= (1 /* Public */ | 2 /* Protected */);
        let nameResolver = traverser.nameResolver;
        let classSymbol = nameResolver.class;
        let existingMethods = symbol_1.PhpSymbol.filterChildren(classSymbol, this._isMethod);
        let existingMethodNames = existingMethods.map(this._toName);
        let fn = (x) => {
            return x.kind === 32 /* Method */ &&
                (!modifiers || (x.modifiers & modifiers) > 0) &&
                !(x.modifiers & (8 /* Final */ | 4 /* Private */)) &&
                existingMethodNames.indexOf(x.name) < 0 &&
                util.ciStringContains(word, x.name);
        };
        let aggregate = new typeAggregate_1.TypeAggregate(this.symbolStore, classSymbol, true);
        let matches = aggregate.members(2 /* Documented */, fn);
        let isIncomplete = matches.length > this.config.maxItems;
        let limit = Math.min(this.config.maxItems, matches.length);
        let items = [];
        for (let n = 0; n < limit; ++n) {
            items.push(this._toCompletionItem(matches[n]));
        }
        return {
            isIncomplete: isIncomplete,
            items: items
        };
    }
    _toCompletionItem(s) {
        let params = symbol_1.PhpSymbol.filterChildren(s, this._isParameter);
        let paramStrings = [];
        for (let n = 0, l = params.length; n < l; ++n) {
            paramStrings.push(this._parameterToString(params[n]));
        }
        let paramString = paramStrings.join(', ');
        let escapedParamString = snippetEscape(paramString);
        let insertText = `${s.name}(${escapedParamString})${snippetEscape(this._returnType(s))}\n{\n\t$0\n\\}`;
        let item = {
            kind: lsp.CompletionItemKind.Method,
            label: s.name,
            insertText: insertText,
            insertTextFormat: lsp.InsertTextFormat.Snippet,
            detail: `override ${s.scope}::${s.name}`
        };
        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }
        return item;
    }
    _returnType(s) {
        if (s.type) {
            return `: ${s.type}`;
        }
        else {
            return '';
        }
    }
    _parameterToString(s) {
        let parts = [];
        if (s.type) {
            let typeName = typeString_1.TypeString.atomicClassArray(s.type).shift();
            if (typeName) {
                typeName = '\\' + typeName;
            }
            else {
                typeName = s.type;
            }
            parts.push(typeName);
        }
        parts.push(s.name);
        if (s.value) {
            parts.push(`= ${s.value}`);
        }
        return parts.join(' ');
    }
    _isMethodDeclarationHeader(node) {
        return node.phraseType === 115 /* MethodDeclarationHeader */;
    }
    _isMemberModifierList(node) {
        return node.phraseType === 110 /* MemberModifierList */;
    }
    _isMethod(s) {
        return s.kind === 32 /* Method */;
    }
    _toName(s) {
        return s.name.toLowerCase();
    }
    _isParameter(s) {
        return s.kind === 128 /* Parameter */;
    }
}
const snippetEscapeRegex = /[$}\\]/g;
function snippetEscape(text) {
    return text.replace(snippetEscapeRegex, snippetEscapeReplacer);
}
function snippetEscapeReplacer(match, offset, subject) {
    return '\\' + match;
}
