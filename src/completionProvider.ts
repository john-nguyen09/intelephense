/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { Token, TokenType, Phrase, PhraseType } from 'php7parser';
import { PhpSymbol, SymbolKind, SymbolModifier } from './symbol';
import { Reference, ReferenceStore, Scope } from './reference';
import { SymbolStore, SymbolTable } from './symbolStore';
import { SymbolReader } from './symbolReader';
import { TypeString } from './typeString';
import { NameResolver } from './nameResolver';
import { ParsedDocument, ParsedDocumentStore } from './parsedDocument';
import { Predicate } from './types';
import { ParseTreeTraverser } from './parseTreeTraverser';
import * as lsp from 'vscode-languageserver-types';
import * as util from './util';
import { TypeAggregate, MemberMergeStrategy } from './typeAggregate';
import { UseDeclarationHelper } from './useDeclarationHelper';

const noCompletionResponse: lsp.CompletionList = {
    items: [],
    isIncomplete: false
};

function keywordCompletionItems(keywords: string[], text: string) {

    let kw: string;
    let items: lsp.CompletionItem[] = [];
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

function createInsertText(s: PhpSymbol, nsName: string, namePhraseType: PhraseType) {
    let insertText = s.name;

    if (nsName && s.name.indexOf(nsName) === 0 && insertText.length > nsName.length + 1) {
        insertText = insertText.slice(nsName.length + 1);
        if (namePhraseType === PhraseType.RelativeQualifiedName) {
            insertText = 'namespace\\' + insertText;
        }

    } else if (nsName && namePhraseType !== PhraseType.FullyQualifiedName && !(s.modifiers & SymbolModifier.Use)) {
        insertText = '\\' + insertText;
    }
    return insertText;
}

function symbolKindToLspSymbolKind(kind: SymbolKind) {

    switch (kind) {
        case SymbolKind.Class:
            return lsp.CompletionItemKind.Class;
        case SymbolKind.Function:
            return lsp.CompletionItemKind.Function;
        case SymbolKind.Constant:
        case SymbolKind.ClassConstant:
            return lsp.CompletionItemKind.Value;
        case SymbolKind.Interface:
            return lsp.CompletionItemKind.Interface;
        case SymbolKind.Namespace:
            return lsp.CompletionItemKind.Module;
        default:
            return lsp.SymbolKind.String;
    }
}

function toMethodCompletionItem(s: PhpSymbol) {

    let item = <lsp.CompletionItem>{
        kind: lsp.CompletionItemKind.Method,
        label: s.name,
        detail: s.name + PhpSymbol.signatureString(s)
    };

    if (s.doc && s.doc.description) {
        item.documentation = s.doc.description;
    }

    if (s.name.slice(0, 2) === '__') {
        //sort magic methods last
        item.sortText = 'zzz';
    } else {
        //all items must have sortText for comparison to occur in vscode
        item.sortText = item.label;
    }

    if(PhpSymbol.hasParameters(s)) {
        item.insertText = item.label + '($0)';
        item.insertTextFormat = lsp.InsertTextFormat.Snippet;
        item.command = triggerParameterHintsCommand;
    } else {
        item.insertText = item.label + '()';
    }
    

    return item;
}

function toClassConstantCompletionItem(s: PhpSymbol) {
    let item = <lsp.CompletionItem>{
        kind: lsp.CompletionItemKind.Value, //@todo use Constant
        label: s.name,
    };

    if (s.doc && s.doc.description) {
        item.documentation = s.doc.description;
    }

    if (s.value) {
        item.detail = '= ' + s.value;
    }

    return item;
}


function toPropertyCompletionItem(s: PhpSymbol) {
    let item = <lsp.CompletionItem>{
        kind: lsp.CompletionItemKind.Property,
        label: !(s.modifiers & SymbolModifier.Static) ? s.name.slice(1) : s.name,
        detail: PhpSymbol.type(s)
    }

    if (s.doc && s.doc.description) {
        item.documentation = s.doc.description;
    }

    return item;
}



export interface CompletionOptions {
    maxItems: number,
    addUseDeclaration: boolean,
    backslashPrefix: boolean
}

const defaultCompletionOptions: CompletionOptions = {
    maxItems: 100,
    addUseDeclaration: true,
    backslashPrefix: true
}

const triggerParameterHintsCommand: lsp.Command = {
    title: 'Trigger Parameter Hints',
    command: 'editor.action.triggerParameterHints'
}

export class CompletionProvider {

    private _maxItems: number;
    private _strategies: CompletionStrategy[];
    private _config: CompletionOptions;
    private static _defaultConfig: CompletionOptions = defaultCompletionOptions;

    constructor(
        public symbolStore: SymbolStore,
        public documentStore: ParsedDocumentStore,
        public refStore: ReferenceStore,
        config?: CompletionOptions) {

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
            new NameCompletion(this._config, this.symbolStore)
        ];

    }

    set config(config: CompletionOptions) {
        this._config = config;
        for (let n = 0, l = this._strategies.length; n < l; ++n) {
            this._strategies[n].config = config;
        }
    }

    provideCompletions(uri: string, position: lsp.Position) {

        let doc = this.documentStore.find(uri);
        let table = this.symbolStore.getSymbolTable(uri);
        let refTable = this.refStore.getReferenceTable(uri);

        if (!doc || !table || !refTable) {
            return noCompletionResponse;
        }

        let traverser = new ParseTreeTraverser(doc, table, refTable);
        traverser.position(position);

        //return early if not in <?php ?>
        let t = traverser.node as Token;
        if(!t || t.tokenType === TokenType.Text) {
            return noCompletionResponse;
        }

        let offset = doc.offsetAtPosition(position);
        let word = doc.wordAtOffset(offset);
        let strategy: CompletionStrategy = null;

        for (let n = 0, l = this._strategies.length; n < l; ++n) {
            if (this._strategies[n].canSuggest(traverser.clone())) {
                strategy = this._strategies[n];
                break;
            }
        }

        return strategy ? strategy.completions(traverser, word, doc.lineSubstring(offset)) : noCompletionResponse;

    }

}

interface CompletionStrategy {
    config: CompletionOptions;
    canSuggest(traverser: ParseTreeTraverser): boolean;
    completions(traverser: ParseTreeTraverser, word: string, lineSubstring: string): lsp.CompletionList;
}

abstract class AbstractNameCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    abstract canSuggest(traverser: ParseTreeTraverser): boolean;

    completions(traverser: ParseTreeTraverser, word: string, lineSubstring: string) {

        let items: lsp.CompletionItem[] = [];
        let namePhrase = traverser.clone().ancestor(this._isNamePhrase) as Phrase;
        let nameResolver = traverser.nameResolver;

        if (!word || !namePhrase) {
            return noCompletionResponse;
        }

        let pred = this._symbolFilter;
        if (namePhrase && namePhrase.phraseType === PhraseType.RelativeQualifiedName) {
            //symbols share current namespace
            word = word.slice(10); //namespace\
            let ns = nameResolver.namespaceName;
            let sf = this._symbolFilter;
            pred = (x) => {
                return sf(x) && x.name.indexOf(ns) === 0;
            };
        }

        let matches = this.symbolStore.match(word, pred);
        if (namePhrase && namePhrase.phraseType === PhraseType.QualifiedName) {
            //keywords and imports
            Array.prototype.push.apply(items, keywordCompletionItems(this._getKeywords(traverser.clone()), word));
            let imports = this._importedSymbols(nameResolver.rules, pred, word);
            matches = this._mergeSymbols(matches, imports);
        }

        let limit = Math.min(matches.length, this.config.maxItems - items.length);
        let isIncomplete = matches.length > this.config.maxItems - items.length;
        let useDeclarationHelper = new UseDeclarationHelper(traverser.document, traverser.symbolTable, traverser.range.start);

        for (let n = 0; n < limit; ++n) {
            items.push(this._toCompletionItem(matches[n], nameResolver.namespaceName, namePhrase.phraseType, useDeclarationHelper));
        }

        return <lsp.CompletionList>{
            items: items,
            isIncomplete: isIncomplete
        }

    }

    protected abstract _getKeywords(traverser: ParseTreeTraverser): string[];

    protected _importedSymbols(rules: PhpSymbol[], pred: Predicate<PhpSymbol>, text: string) {

        let filteredRules: PhpSymbol[] = [];
        let r: PhpSymbol;
        for (let n = 0, l = rules.length; n < l; ++n) {
            r = rules[n];
            if (r.associated && r.associated.length > 0 && util.ciStringContains(text, r.name)) {
                filteredRules.push(r);
            }
        }

        //lookup associated symbol
        let s: PhpSymbol;
        let merged: PhpSymbol;
        let imported: PhpSymbol[] = [];
        for (let n = 0, l = filteredRules.length; n < l; ++n) {
            r = filteredRules[n];
            s = this.symbolStore.find(r.associated[0].name, pred).shift();
            if (s) {
                merged = PhpSymbol.clone(s);
                merged.associated = r.associated;
                merged.modifiers |= SymbolModifier.Use;
                merged.name = r.name;
                imported.push(merged);
            }
        }
        return imported;
    }

    protected _toCompletionItem(s: PhpSymbol, namespaceName: string, namePhraseType: PhraseType, useDeclarationHelper: UseDeclarationHelper): lsp.CompletionItem {

        let item = <lsp.CompletionItem>{
            kind: lsp.CompletionItemKind.Class,
            label: PhpSymbol.notFqn(s.name),
        }

        this._setInsertText(item, s, namespaceName, namePhraseType, useDeclarationHelper);

        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }

        switch (s.kind) {

            case SymbolKind.Interface:
                item.kind = lsp.CompletionItemKind.Interface;
            //fall though
            case SymbolKind.Class:
            case SymbolKind.Trait:
                if ((s.modifiers & SymbolModifier.Use) > 0 && s.associated && s.associated.length) {
                    item.detail = s.associated[0].name;
                } else {
                    item.detail = s.name;
                }
                break;

            case SymbolKind.Constant:
                item.kind = lsp.CompletionItemKind.Value;
                if (s.value) {
                    item.detail = s.value;
                }
                break;

            case SymbolKind.Function:
                item.kind = lsp.CompletionItemKind.Function;
                item.detail = s.name + PhpSymbol.signatureString(s);
                if(PhpSymbol.hasParameters(s)) {
                    item.insertText += '($0)';
                    item.insertTextFormat = lsp.InsertTextFormat.Snippet;
                    item.command = triggerParameterHintsCommand;
                } else {
                    item.insertText += '()';
                }
                
                break;

            case SymbolKind.Namespace:
                return <lsp.CompletionItem>{
                    label: s.name,
                    kind: lsp.CompletionItemKind.Module
                }

            default:
                throw new Error('Invalid Argument');

        }

        return item;

    }

    protected _setInsertText(item: lsp.CompletionItem, s: PhpSymbol, namespaceName: string, namePhraseType: PhraseType, useDeclarationHelper: UseDeclarationHelper) {
        const kindMask = SymbolKind.Constant | SymbolKind.Function;
        let notFqn = PhpSymbol.notFqn(s.name);

        if (
            (s.modifiers & SymbolModifier.Use) > 0 ||
            (s.kind === SymbolKind.Constant && this._isMagicConstant(s.name)) ||
            ((s.kind & kindMask) > 0 && notFqn === s.name && (!this.config.backslashPrefix || !namespaceName))
        ) {
            item.insertText = s.name;

        } else if (this.config.addUseDeclaration && notFqn !== s.name && !useDeclarationHelper.findUseSymbolByName(notFqn) && namespaceName !== PhpSymbol.namespace(s.name)) {
            item.insertText = notFqn;
            item.additionalTextEdits = [useDeclarationHelper.insertDeclarationTextEdit(s)];

        } else if (namespaceName && s.name.indexOf(namespaceName) === 0 && s.name.length > namespaceName.length + 1) {
            item.insertText = s.name.slice(namespaceName.length + 1);
            if (namePhraseType === PhraseType.RelativeQualifiedName) {
                item.insertText = 'namespace\\' + item.insertText;
            }

        } else if (namespaceName && namePhraseType !== PhraseType.FullyQualifiedName && (!(s.kind & kindMask) || this.config.backslashPrefix)) {
            item.insertText = '\\' + s.name;
        } else {
            item.insertText = s.name;
        }

        return item;
    }

    private _isMagicConstant(text: string) {
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

    protected _isNamePhrase(node: Phrase | Token) {
        switch ((<Phrase>node).phraseType) {
            case PhraseType.QualifiedName:
            case PhraseType.FullyQualifiedName:
            case PhraseType.RelativeQualifiedName:
                return true;
            default:
                return false;
        }
    }

    protected abstract _symbolFilter(s: PhpSymbol): boolean;

    protected _mergeSymbols(matches: PhpSymbol[], imports: PhpSymbol[]) {

        let merged: PhpSymbol[] = imports.slice(0);
        let map: { [index: string]: PhpSymbol } = {};
        let imported: PhpSymbol;
        let s: PhpSymbol;

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

class ClassTypeDesignatorCompletion extends AbstractNameCompletion {

    private static _keywords = [
        'class', 'static', 'namespace'
    ];

    canSuggest(traverser: ParseTreeTraverser) {

        return ParsedDocument.isPhrase(traverser.parent(), [PhraseType.NamespaceName]) &&
            ParsedDocument.isPhrase(traverser.parent(),
                [PhraseType.FullyQualifiedName, PhraseType.QualifiedName, PhraseType.RelativeQualifiedName]) &&
            ParsedDocument.isPhrase(traverser.parent(), [PhraseType.ClassTypeDesignator]);

    }

    protected _symbolFilter(s: PhpSymbol) {
        return s.kind === SymbolKind.Class &&
            !(s.modifiers & (SymbolModifier.Anonymous | SymbolModifier.Abstract));
    }

    protected _getKeywords(traverser: ParseTreeTraverser) {

        if (traverser.ancestor(this._isQualifiedName)) {
            return ClassTypeDesignatorCompletion._keywords;
        }
        return [];
    }

    protected _toCompletionItem(s: PhpSymbol, namespaceName: string, namePhraseType: PhraseType, useDeclarationHelper: UseDeclarationHelper) {

        let item = super._toCompletionItem(s, namespaceName, namePhraseType, useDeclarationHelper);
        let aggregate = new TypeAggregate(this.symbolStore, s);
        let constructor = aggregate.firstMember(this._isConstructor);
        item.kind = lsp.CompletionItemKind.Constructor;
        if(constructor && PhpSymbol.hasParameters(constructor)){
            item.insertText += '($0)';
            item.insertTextFormat = lsp.InsertTextFormat.Snippet;
            item.command = triggerParameterHintsCommand;
        }
        return item;

    }

    private _isConstructor(s:PhpSymbol) {
        return s.kind === SymbolKind.Constructor;
    }

    private _isQualifiedName(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.QualifiedName;
    }

}

class SimpleVariableCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    canSuggest(traverser: ParseTreeTraverser) {
        return ParsedDocument.isToken(traverser.node, [TokenType.Dollar, TokenType.VariableName]) &&
            ParsedDocument.isPhrase(traverser.parent(), [PhraseType.SimpleVariable]);
    }

    completions(traverser: ParseTreeTraverser, word: string, lineSubstring: string) {

        if (!word) {
            return noCompletionResponse;
        }

        let scope = traverser.scope;
        let symbolMask = SymbolKind.Variable | SymbolKind.Parameter;
        let varSymbols = PhpSymbol.filterChildren(scope, (x) => {
            return (x.kind & symbolMask) > 0 && x.name.indexOf(word) === 0;
        });
        //also suggest built in globals vars
        Array.prototype.push.apply(varSymbols, this.symbolStore.match(word, this._isBuiltInGlobalVar));

        let limit = Math.min(varSymbols.length, this.config.maxItems);
        let isIncomplete = varSymbols.length > this.config.maxItems;

        let items: lsp.CompletionItem[] = [];
        let refScope = traverser.refTable.scopeAtPosition(scope.location.range.start);
        let varTable = this._varTypeMap(refScope);

        for (let n = 0; n < limit; ++n) {
            items.push(this._toVariableCompletionItem(varSymbols[n], varTable));
        }

        return <lsp.CompletionList>{
            items: items,
            isIncomplete: isIncomplete
        }

    }

    private _toVariableCompletionItem(s: PhpSymbol, varTable: { [index: string]: string }) {

        let item = <lsp.CompletionItem>{
            label: s.name,
            kind: lsp.CompletionItemKind.Variable,
            detail: varTable[s.name] ? varTable[s.name] : ''
        }

        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }

        return item;

    }

    private _varTypeMap(s: Scope) {

        let map: { [index: string]: string } = {};

        if(!s || !s.children) {
            return {};
        }
        
        let ref:Reference;
        for (let n = 0, l = s.children.length; n < l; ++n) {
            ref = s.children[n] as Reference;
            if (ref.kind === SymbolKind.Variable || ref.kind === SymbolKind.Parameter) {
                map[ref.name] = TypeString.merge(map[ref.name], ref.type);
            }
        }

        return map;
    }

    private _isBuiltInGlobalVar(s: PhpSymbol) {
        return s.kind === SymbolKind.Variable && !s.location;
    }

}

class NameCompletion extends AbstractNameCompletion {

    private static _statementKeywords = [
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

    private static _expressionKeywords = [
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

    private static _openTagCompletion: lsp.CompletionList = {
        isIncomplete: false,
        items: [{
            kind: lsp.CompletionItemKind.Keyword,
            label: '<?php',
            insertText: 'php'
        }]
    }

    private static _extendsOrImplementsRegexRegex = /\b(?:class|interface)\s+[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*\s+[a-z]+$/;
    private static _implementsRegex = /\bclass\s+[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*(?:\s+extends\s+[a-zA-Z_\x80-\xff][a-zA-Z0-9_\x80-\xff]*)?\s+[a-z]+$/;

    canSuggest(traverser: ParseTreeTraverser) {

        return ParsedDocument.isPhrase(traverser.parent(), [PhraseType.NamespaceName]) &&
            traverser.ancestor(this._isNamePhrase) !== null;
    }

    completions(traverser: ParseTreeTraverser, word: string, lineSubstring: string) {

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

    protected _getKeywords(traverser: ParseTreeTraverser) {
        let kw: string[] = [];
        Array.prototype.push.apply(kw, NameCompletion._expressionKeywords);
        Array.prototype.push.apply(kw, NameCompletion._statementKeywords);
        return kw;
    }

    protected _symbolFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Function | SymbolKind.Constant)) > 0 &&
            !(s.modifiers & SymbolModifier.Anonymous);
    }

}

abstract class MemberAccessCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    abstract canSuggest(traverser: ParseTreeTraverser);

    completions(traverser: ParseTreeTraverser, word: string) {

        let scopedAccessExpr = traverser.ancestor(this._isMemberAccessExpr);
        let scopePhrase = traverser.nthChild(0) as Phrase;
        let type = this._resolveType(traverser);
        let typeNames = TypeString.atomicClassArray(type);

        if (!typeNames.length) {
            return noCompletionResponse;
        }

        let nameResolver = traverser.nameResolver;
        let classAggregateType = TypeAggregate.create(this.symbolStore, nameResolver.className);
        let typeName: string;
        let fn: Predicate<PhpSymbol>;
        let typeAggregate: TypeAggregate;
        let symbols: PhpSymbol[] = [];

        for (let n = 0, l = typeNames.length; n < l; ++n) {
            typeName = typeNames[n];
            if (classAggregateType && classAggregateType.name === typeName) {
                typeAggregate = classAggregateType;
            } else {
                typeAggregate = TypeAggregate.create(this.symbolStore, typeName);
            }

            if (!typeAggregate) {
                continue;
            }

            fn = this._createMemberPredicate(typeName, word, classAggregateType);
            Array.prototype.push.apply(symbols, typeAggregate.members(MemberMergeStrategy.Documented, fn));
        }

        symbols = Array.from(new Set<PhpSymbol>(symbols)); //unique
        let isIncomplete = symbols.length > this.config.maxItems;
        let limit = Math.min(symbols.length, this.config.maxItems);
        let items: lsp.CompletionItem[] = [];

        for (let n = 0; n < limit; ++n) {
            items.push(this._toCompletionItem(symbols[n]));
        }

        return <lsp.CompletionList>{
            isIncomplete: isIncomplete,
            items: items
        }

    }

    private _resolveType(traverser: ParseTreeTraverser): string {

        //assumed that traverser is on the member scope node
        let node: Phrase;
        let arrayDereference = 0;
        let ref: Reference;

        while (true) {
            node = traverser.node as Phrase;
            switch (node.phraseType) {
                case PhraseType.FullyQualifiedName:
                case PhraseType.RelativeQualifiedName:
                case PhraseType.QualifiedName:
                case PhraseType.SimpleVariable:
                case PhraseType.RelativeScope:
                    ref = traverser.reference;
                    break;

                case PhraseType.MethodCallExpression:
                case PhraseType.PropertyAccessExpression:
                case PhraseType.ScopedCallExpression:
                case PhraseType.ScopedPropertyAccessExpression:
                case PhraseType.ClassConstantAccessExpression:
                    if (traverser.child(this._isMemberName)) {
                        ref = traverser.reference;
                    }
                    break;

                case PhraseType.EncapsulatedExpression:
                    if (traverser.child(ParsedDocument.isPhrase)) {
                        continue;
                    }
                    break;

                case PhraseType.ObjectCreationExpression:
                    if (traverser.child(this._isClassTypeDesignator) && traverser.child(ParsedDocument.isNamePhrase)) {
                        ref = traverser.reference;
                    }
                    break;

                case PhraseType.SimpleAssignmentExpression:
                case PhraseType.ByRefAssignmentExpression:
                    if (traverser.nthChild(0)) {
                        continue;
                    }
                    break;

                case PhraseType.FunctionCallExpression:
                    if (traverser.nthChild(0)) {
                        ref = traverser.reference;
                    }
                    break;

                case PhraseType.SubscriptExpression:
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
            type = TypeString.arrayDereference(type);
        }

        return type;

    }

    protected abstract _createMemberPredicate(scopeName: string, word: string, classContext: TypeAggregate): Predicate<PhpSymbol>;

    protected _isMemberAccessExpr(node: Phrase | Token) {
        switch ((<Phrase>node).phraseType) {
            case PhraseType.ScopedCallExpression:
            case PhraseType.ErrorScopedAccessExpression:
            case PhraseType.ClassConstantAccessExpression:
            case PhraseType.ScopedPropertyAccessExpression:
            case PhraseType.PropertyAccessExpression:
            case PhraseType.MethodCallExpression:
                return true;
            default:
                return false;
        }
    }

    protected _toCompletionItem(s: PhpSymbol) {
        switch (s.kind) {
            case SymbolKind.ClassConstant:
                return toClassConstantCompletionItem(s);
            case SymbolKind.Method:
                return toMethodCompletionItem(s);
            case SymbolKind.Property:
                return toPropertyCompletionItem(s);
            default:
                throw Error('Invalid Argument');
        }
    }

    private _isMemberName(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.MemberName || (<Phrase>node).phraseType === PhraseType.ScopedMemberName;
    }

    private _isClassTypeDesignator(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.ClassTypeDesignator;
    }

}

class ScopedAccessCompletion extends MemberAccessCompletion {


    canSuggest(traverser: ParseTreeTraverser) {
        const scopedAccessPhrases = [
            PhraseType.ScopedCallExpression,
            PhraseType.ErrorScopedAccessExpression,
            PhraseType.ClassConstantAccessExpression,
            PhraseType.ScopedPropertyAccessExpression
        ];

        if (ParsedDocument.isToken(traverser.node, [TokenType.ColonColon])) {
            return ParsedDocument.isPhrase(traverser.parent(), scopedAccessPhrases);
        }

        if (ParsedDocument.isToken(traverser.node, [TokenType.VariableName])) {
            return ParsedDocument.isPhrase(traverser.parent(), [PhraseType.ScopedMemberName]);
        }

        if (ParsedDocument.isToken(traverser.node, [TokenType.Dollar])) {
            return ParsedDocument.isPhrase(traverser.parent(), [PhraseType.SimpleVariable]) &&
                ParsedDocument.isPhrase(traverser.parent(), [PhraseType.ScopedMemberName]);
        }

        return ParsedDocument.isPhrase(traverser.parent(), [PhraseType.Identifier]) &&
            ParsedDocument.isPhrase(traverser.parent(), [PhraseType.ScopedMemberName]);
    }

    protected _createMemberPredicate(scopeName: string, word: string, classContext: TypeAggregate): Predicate<PhpSymbol> {
        if (classContext && scopeName === classContext.name) {
            //public, protected, private
            return (x) => {
                return (x.modifiers & SymbolModifier.Static) > 0 && util.ciStringContains(word, x.name);
            };
        } else if (classContext && classContext.isBaseClass(scopeName)) {
            //public, protected
            //looking for non static here as well to handle parent keyword
            return (x) => {
                return !(x.modifiers & SymbolModifier.Private) && util.ciStringContains(word, x.name);
            };

        } else if (classContext && classContext.isAssociated(scopeName)) {
            //public, protected
            return (x) => {
                return (x.modifiers & SymbolModifier.Static) > 0 &&
                    !(x.modifiers & SymbolModifier.Private) &&
                    util.ciStringContains(word, x.name);
            };

        } else {
            //public
            const mask = SymbolModifier.Static | SymbolModifier.Public;
            return (x) => {
                return (x.modifiers & mask) === mask && util.ciStringContains(word, x.name);
            };
        }
    }

}

class ObjectAccessCompletion extends MemberAccessCompletion {

    canSuggest(traverser: ParseTreeTraverser) {

        if (ParsedDocument.isToken(traverser.node, [TokenType.Arrow])) {
            return ParsedDocument.isPhrase(traverser.parent(),
                [PhraseType.PropertyAccessExpression, PhraseType.MethodCallExpression]);
        }

        return ParsedDocument.isPhrase(traverser.parent(), [PhraseType.MemberName]);

    }

    protected _createMemberPredicate(scopeName: string, word: string, classContext: TypeAggregate): Predicate<PhpSymbol> {

        //php allows static methods to be accessed with ->
        if (classContext && scopeName === classContext.name) {
            //public, protected, private
            return (x) => {
                return util.ciStringContains(word, x.name);
            };
        } else if (classContext && classContext.isAssociated(scopeName)) {
            //public, protected
            const mask = SymbolModifier.Private;
            return (x) => {
                return !(x.modifiers & mask) && util.ciStringContains(word, x.name);
            };

        } else {
            //public
            const mask = SymbolModifier.Protected | SymbolModifier.Private;
            return (x) => {
                return !(x.modifiers & mask) && util.ciStringContains(word, x.name);
            };
        }
    }

}

class TypeDeclarationCompletion extends AbstractNameCompletion {

    private static _keywords = [
        'self', 'array', 'callable', 'bool', 'float', 'int', 'string'
    ];

    canSuggest(traverser: ParseTreeTraverser) {
        return ParsedDocument.isToken(traverser.node, [TokenType.Name, TokenType.Backslash, TokenType.Array, TokenType.Callable]) &&
            traverser.ancestor(this._isTypeDeclaration) !== undefined;
    }

    protected _getKeywords(traverser: ParseTreeTraverser) {
        return TypeDeclarationCompletion._keywords;
    }

    protected _symbolFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Interface)) > 0;
    }

    private _isTypeDeclaration(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.TypeDeclaration;
    }

}

class ClassBaseClauseCompletion extends AbstractNameCompletion {

    canSuggest(traverser: ParseTreeTraverser) {
        return traverser.ancestor(this._isClassBaseClause) !== undefined;
    }

    protected _getKeywords(traverser: ParseTreeTraverser) {
        return [];
    }

    protected _symbolFilter(s: PhpSymbol) {
        return s.kind === SymbolKind.Class && !(s.modifiers & SymbolModifier.Final);
    }

    private _isClassBaseClause(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.ClassBaseClause;
    }

}

class InterfaceClauseCompletion extends AbstractNameCompletion {

    canSuggest(traverser: ParseTreeTraverser) {
        return traverser.ancestor(this._isInterfaceClause) !== undefined;

    }

    protected _getKeywords(traverser: ParseTreeTraverser) {
        return [];
    }

    protected _symbolFilter(s: PhpSymbol) {
        return s.kind === SymbolKind.Interface;
    }

    private _isInterfaceClause(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.ClassInterfaceClause ||
            (<Phrase>node).phraseType === PhraseType.InterfaceBaseClause;
    }

}

class TraitUseClauseCompletion extends AbstractNameCompletion {

    canSuggest(traverser: ParseTreeTraverser) {
        return traverser.ancestor(this._isNamePhrase) &&
            ParsedDocument.isPhrase(traverser.parent(), [PhraseType.QualifiedNameList]) &&
            ParsedDocument.isPhrase(traverser.parent(), [PhraseType.TraitUseClause]);
    }

    protected _getKeywords(traverser: ParseTreeTraverser) {
        return [];
    }

    protected _symbolFilter(s: PhpSymbol) {
        return s.kind === SymbolKind.Trait;
    }

}

class NamespaceDefinitionCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    canSuggest(traverser: ParseTreeTraverser) {
        return traverser.ancestor(this._isNamespaceDefinition) !== undefined;
    }

    completions(traverser: ParseTreeTraverser, word: string) {

        let items: lsp.CompletionItem[] = [];
        let matches = PhpSymbol.unique(this.symbolStore.match(word, this._symbolFilter));
        let limit = Math.min(matches.length, this.config.maxItems);
        let isIncomplete = matches.length > this.config.maxItems;

        for (let n = 0; n < limit; ++n) {
            items.push(this._toNamespaceCompletionItem(matches[n]));
        }

        return <lsp.CompletionList>{
            items: items,
            isIncomplete: isIncomplete
        }

    }

    private _toNamespaceCompletionItem(s: PhpSymbol) {
        return <lsp.CompletionItem>{
            label: s.name,
            kind: lsp.CompletionItemKind.Module
        }
    }

    private _symbolFilter(s: PhpSymbol) {
        return s.kind === SymbolKind.Namespace;
    }

    private _isNamespaceDefinition(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.NamespaceDefinition;
    }


}

class NamespaceUseClauseCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    canSuggest(traverser: ParseTreeTraverser) {
        return traverser.ancestor(this._isNamespaceUseClause) !== undefined;
    }

    completions(traverser: ParseTreeTraverser, word: string) {

        let items: lsp.CompletionItem[] = [];
        let namespaceUseDecl = traverser.ancestor(this._isNamespaceUseDeclaration) as Phrase;

        if (!word) {
            return noCompletionResponse;
        }

        let kind = this._modifierToSymbolKind(<Token>traverser.child(this._isModifier));

        let pred = (x: PhpSymbol) => {
            return (x.kind & kind) > 0 && !(x.modifiers & SymbolModifier.Use);
        }

        let matches = PhpSymbol.unique(this.symbolStore.match(word, pred));
        let isIncomplete = matches.length > this.config.maxItems;
        let limit = Math.min(this.config.maxItems, matches.length);
        for (let n = 0; n < limit; ++n) {
            items.push(this._toCompletionItem(matches[n]));
        }

        return <lsp.CompletionList>{
            isIncomplete: isIncomplete,
            items: items
        }

    }

    private _toCompletionItem(s: PhpSymbol) {
        let name = s.kind === SymbolKind.Namespace ? s.name : PhpSymbol.notFqn(s.name);
        let item = lsp.CompletionItem.create(name);
        item.insertText = s.name;
        item.kind = symbolKindToLspSymbolKind(s.kind);
        if (s.kind !== SymbolKind.Namespace && name !== s.name) {
            item.detail = s.name;
        }

        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }

        return item;
    }

    private _isNamespaceUseDeclaration(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.NamespaceUseDeclaration;
    }

    private _isNamespaceUseClause(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.NamespaceUseClause;
    }

    private _modifierToSymbolKind(token: Token) {
        if (!token) {
            return SymbolKind.Class | SymbolKind.Interface | SymbolKind.Namespace;
        }

        switch (token.tokenType) {
            case TokenType.Function:
                return SymbolKind.Function;
            case TokenType.Const:
                return SymbolKind.Constant;
            default:
                return SymbolKind.Class | SymbolKind.Interface | SymbolKind.Namespace;
        }
    }

    private _isModifier(node: Phrase | Token) {
        switch ((<Token>node).tokenType) {
            case TokenType.Class:
            case TokenType.Function:
            case TokenType.Const:
                return true;
            default:
                return false;
        }
    }

}

class NamespaceUseGroupClauseCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    canSuggest(traverser: ParseTreeTraverser) {
        return traverser.ancestor(this._isNamespaceUseGroupClause) !== undefined;
    }

    completions(traverser: ParseTreeTraverser, word: string) {

        let items: lsp.CompletionItem[] = [];
        if (!word) {
            return noCompletionResponse;
        }

        let nsUseGroupClause = traverser.ancestor(this._isNamespaceUseGroupClause) as Phrase;
        let nsUseGroupClauseModifier = traverser.child(this._isModifier) as Token;
        let nsUseDecl = traverser.ancestor(this._isNamespaceUseDeclaration) as Phrase;
        let nsUseDeclModifier = traverser.child(this._isModifier) as Token;
        let kind = this._modifierToSymbolKind(nsUseGroupClauseModifier || nsUseDeclModifier);
        let prefix = '';
        if (nsUseDeclModifier) {
            traverser.parent();
        }

        if (traverser.child(this._isNamespaceName)) {
            prefix = traverser.text;
        }

        let pred = (x: PhpSymbol) => {
            return (x.kind & kind) > 0 && !(x.modifiers & SymbolModifier.Use) && (!prefix || x.name.indexOf(prefix) === 0);
        };

        let matches = this.symbolStore.match(word, pred);
        let isIncomplete = matches.length > this.config.maxItems;
        let limit = Math.min(this.config.maxItems, matches.length);
        for (let n = 0; n < limit; ++n) {
            items.push(this._toCompletionItem(matches[n], matches[n].name.slice(prefix.length + 1))); //+1 for \
        }

        return <lsp.CompletionList>{
            isIncomplete: isIncomplete,
            items: items
        }

    }

    private _toCompletionItem(s: PhpSymbol, insertText: string) {
        let item = lsp.CompletionItem.create(PhpSymbol.notFqn(s.name));
        item.insertText = insertText;
        item.kind = symbolKindToLspSymbolKind(s.kind);
        item.detail = s.name;

        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }

        return item;
    }

    private _isNamespaceUseGroupClause(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.NamespaceUseGroupClause;
    }

    private _isNamespaceUseDeclaration(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.NamespaceUseDeclaration;
    }

    private _isModifier(node: Phrase | Token) {
        switch ((<Token>node).tokenType) {
            case TokenType.Class:
            case TokenType.Function:
            case TokenType.Const:
                return true;
            default:
                return false;
        }
    }

    private _isNamespaceName(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.NamespaceName;
    }

    private _modifierToSymbolKind(modifier: Token) {
        if (!modifier) {
            return SymbolKind.Class;
        }

        switch (modifier.tokenType) {
            case TokenType.Function:
                return SymbolKind.Function;
            case TokenType.Const:
                return SymbolKind.Constant;
            default:
                return SymbolKind.Class;
        }
    }

}

class DeclarationBodyCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions) { }

    private static _phraseTypes = [
        PhraseType.ClassDeclarationBody, PhraseType.InterfaceDeclarationBody, PhraseType.TraitDeclarationBody,
        PhraseType.ErrorClassMemberDeclaration
    ];

    private static _keywords = [
        'var', 'public', 'private', 'protected', 'final', 'function', 'abstract', 'implements', 'extends'
    ];

    canSuggest(traverser: ParseTreeTraverser) {
        return ParsedDocument.isPhrase(traverser.parent(), DeclarationBodyCompletion._phraseTypes) ||
            (ParsedDocument.isPhrase(traverser.node, [PhraseType.Error]) &&  ParsedDocument.isPhrase(traverser.parent(), DeclarationBodyCompletion._phraseTypes));
    }

    completions(traverser: ParseTreeTraverser, word: string) {
        return <lsp.CompletionList>{
            items: keywordCompletionItems(DeclarationBodyCompletion._keywords, word)
        }
    }

}

class MethodDeclarationHeaderCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    canSuggest(traverser: ParseTreeTraverser) {
        let nameResolver = traverser.nameResolver;
        let thisSymbol = nameResolver.class;
        return ParsedDocument.isPhrase(traverser.parent(), [PhraseType.Identifier]) &&
            ParsedDocument.isPhrase(traverser.parent(), [PhraseType.MethodDeclarationHeader]) &&
            thisSymbol !== undefined && thisSymbol.associated !== undefined && thisSymbol.associated.length > 0;
    }

    completions(traverser: ParseTreeTraverser, word: string) {

        let memberDecl = traverser.ancestor(this._isMethodDeclarationHeader) as Phrase;
        let modifiers = SymbolReader.modifierListToSymbolModifier(<Phrase>traverser.child(this._isMemberModifierList));

        if (modifiers & (SymbolModifier.Private | SymbolModifier.Abstract)) {
            return noCompletionResponse;
        }

        modifiers &= (SymbolModifier.Public | SymbolModifier.Protected);
        let nameResolver = traverser.nameResolver;
        let classSymbol = nameResolver.class;
        let existingMethods = PhpSymbol.filterChildren(classSymbol, this._isMethod);
        let existingMethodNames = existingMethods.map<string>(this._toName);

        let fn = (x: PhpSymbol) => {
            return x.kind === SymbolKind.Method &&
                (!modifiers || (x.modifiers & modifiers) > 0) &&
                !(x.modifiers & (SymbolModifier.Final | SymbolModifier.Private)) &&
                existingMethodNames.indexOf(x.name) < 0 &&
                util.ciStringContains(word, x.name);
        }

        let aggregate = new TypeAggregate(this.symbolStore, classSymbol, true);
        let matches = aggregate.members(MemberMergeStrategy.Documented, fn);
        let isIncomplete = matches.length > this.config.maxItems;
        let limit = Math.min(this.config.maxItems, matches.length);
        let items: lsp.CompletionItem[] = [];

        for (let n = 0; n < limit; ++n) {
            items.push(this._toCompletionItem(matches[n]));
        }

        return <lsp.CompletionList>{
            isIncomplete: isIncomplete,
            items: items
        }

    }

    private _toCompletionItem(s: PhpSymbol) {

        let params = PhpSymbol.filterChildren(s, this._isParameter);
        let paramStrings: string[] = [];

        for (let n = 0, l = params.length; n < l; ++n) {
            paramStrings.push(this._parameterToString(params[n]));
        }

        let paramString = paramStrings.join(', ');
        let escapedParamString = snippetEscape(paramString);
        let insertText = `${s.name}(${escapedParamString})${snippetEscape(this._returnType(s))}\n{\n\t$0\n\\}`;

        let item: lsp.CompletionItem = {
            kind: lsp.CompletionItemKind.Method,
            label: s.name,
            insertText: insertText,
            insertTextFormat: lsp.InsertTextFormat.Snippet,
            detail: s.scope
        };

        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }

        return item;

    }

    private _returnType(s: PhpSymbol) {
        if (s.type) {
            return `: ${s.type}`;
        } else {
            return '';
        }
    }

    private _parameterToString(s: PhpSymbol) {

        let parts: String[] = [];

        if (s.type) {
            let typeName = TypeString.atomicClassArray(s.type).shift();
            if (typeName) {
                typeName = '\\' + typeName;
            } else {
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

    private _isMethodDeclarationHeader(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.MethodDeclarationHeader;
    }

    private _isMemberModifierList(node: Phrase | Token) {
        return (<Phrase>node).phraseType === PhraseType.MemberModifierList;
    }

    private _isMethod(s: PhpSymbol) {
        return s.kind === SymbolKind.Method;
    }

    private _toName(s: PhpSymbol) {
        return s.name;
    }

    private _isParameter(s: PhpSymbol) {
        return s.kind === SymbolKind.Parameter;
    }

}

const snippetEscapeRegex = /[$}\\]/g;

function snippetEscape(text: string) {
    return text.replace(snippetEscapeRegex, snippetEscapeReplacer);
}

function snippetEscapeReplacer(match: string, offset: number, subject: string) {
    return '\\' + match;
}
