/* Copyright (c) Ben Robert Mewburn
 * Licensed under the ISC Licence.
 */

'use strict';

import { PhpSymbol, SymbolKind, SymbolModifier, UniqueSymbolSet } from '../symbol';
import { Reference, ReferenceStore, Scope } from '../reference';
import { SymbolStore, SymbolTable } from '../symbolStore';
import { SymbolReader } from '../symbolReader';
import { TypeString } from '../typeString';
import { ParsedDocument, ParsedDocumentStore } from '../parsedDocument';
import { Predicate } from '../types';
import { ParseTreeTraverser } from '../parseTreeTraverser';
import * as lsp from 'vscode-languageserver-types';
import * as util from '../utils';
import { TypeAggregate, MemberMergeStrategy } from '../typeAggregate';
import { UseDeclarationHelper } from '../useDeclarationHelper';
import { SyntaxNode } from 'tree-sitter';

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

function symbolKindToLspSymbolKind(kind: SymbolKind) {

    switch (kind) {
        case SymbolKind.Class:
        case SymbolKind.Trait:
            return lsp.CompletionItemKind.Class;
        case SymbolKind.Function:
            return lsp.CompletionItemKind.Function;
        case SymbolKind.Method:
            return lsp.CompletionItemKind.Method;
        case SymbolKind.Constant:
        case SymbolKind.ClassConstant:
            return lsp.CompletionItemKind.Value;
        case SymbolKind.Interface:
            return lsp.CompletionItemKind.Interface;
        case SymbolKind.Namespace:
            return lsp.CompletionItemKind.Module;
        case SymbolKind.Constructor:
            return lsp.CompletionItemKind.Constructor;
        case SymbolKind.Property:
            return lsp.CompletionItemKind.Property;
        case SymbolKind.Parameter:
        case SymbolKind.Variable:
            return lsp.CompletionItemKind.Variable;
        case SymbolKind.File:
            return lsp.CompletionItemKind.File;
        default:
            return lsp.SymbolKind.String;
    }
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
            new InstanceOfTypeDesignatorCompletion(this._config, this.symbolStore),
            new NameCompletion(this._config, this.symbolStore)
        ];

    }

    set config(config: CompletionOptions) {
        this._config = config;
        for (let n = 0, l = this._strategies.length; n < l; ++n) {
            this._strategies[n].config = config;
        }
    }

    async provideCompletions(uri: string, position: lsp.Position) {
        let response = noCompletionResponse;

        await this.documentStore.acquireLock(uri, async () => {
            let doc = this.documentStore.find(uri);
            let table = await this.symbolStore.getSymbolTable(uri);
            let refTable = this.refStore.getReferenceTable(uri);

            if (!doc || !table || !refTable) {
                return;
            }

            let traverser = new ParseTreeTraverser(doc, table, refTable);
            traverser.position(position);

            //return early if not in <?php ?>
            let t = traverser.node;
            if (!t || t.type === 'text') {
                return;
            }

            let offset = doc.offsetAtPosition(position);
            let word = doc.wordAtOffset(offset);
            let strategy: CompletionStrategy | null = null;

            for (let n = 0, l = this._strategies.length; n < l; ++n) {
                if (this._strategies[n].canSuggest(traverser.clone())) {
                    strategy = this._strategies[n];
                    break;
                }
            }

            if (strategy) {
                response = await strategy.completions(traverser, word, doc.lineSubstring(offset));
            }
        });

        return response;
    }

}

interface CompletionStrategy {
    config: CompletionOptions;
    canSuggest(traverser: ParseTreeTraverser): boolean;
    completions(traverser: ParseTreeTraverser, word: string, lineSubstring: string): Promise<lsp.CompletionList>;
}

abstract class AbstractNameCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    /**
     * Child classes should override but call this first.
     * It moves the traverser to previous token if the current token is a backslash.
     * This corrects for errors when a name has a trailing backslash.
     * @param traverser 
     */
    canSuggest(traverser: ParseTreeTraverser): boolean {
        const node = traverser.node;
        if (node && node.type === '\\') {
            traverser.prevToken();
        }
        return true;
    }

    async completions(traverser: ParseTreeTraverser, word: string, lineSubstring: string) {

        let items: lsp.CompletionItem[] = [];
        let namePhrase = traverser.clone().ancestor(this._isNamePhrase);
        let nameResolver = traverser.nameResolver;

        if (!word || !namePhrase) {
            return noCompletionResponse;
        }

        let pred = this._symbolFilter;
        let addUseDeclarationEnabled = this.config.addUseDeclaration;
        let fqnOffset = 0;
        let isUnqualified = false;
        const useDeclarationHelper = new UseDeclarationHelper(
            traverser.document, traverser.symbolTable, (<lsp.Range>traverser.range).start
        );
        const importMap: { [index: string]: PhpSymbol } = {};
        let qualifiedNameRule: PhpSymbol | null = null;

        if (word.indexOf('\\') === 0) {

            //If the user has started typing a RelativeQualifiedName, FullyQualifiedName,
            //or a QualifiedName with an ns separator then it is asumed they must 
            //intend to have an expanded name with no use declaration.
            //Allow namespaces in this case to enable progresive discovery of symbols.
            //Expand word to match start of symbol fqn

            // if (namePhrase.kind === PhraseKind.RelativeQualifiedName) {
            //     //symbols share current namespace
            //     word = nameResolver.resolveRelative(word.slice(10)); //namespace\
            // } else
            if (namePhrase.type === 'qualified_name') {
                qualifiedNameRule = nameResolver.matchImportedSymbol(word.slice(0, word.indexOf('\\')), SymbolKind.Class);
                word = nameResolver.resolveNotFullyQualified(word);
            }

            addUseDeclarationEnabled = false;
            fqnOffset = word.lastIndexOf('\\') + 1

        } else {

            //QualifiedName with no ns separator (unqualified)
            //It is assumed that the user is wanting to match the non fqn name,  
            //a keyword, or an existing use declaration.
            //Only allow namespace if in global namespace.

            isUnqualified = true;
            const sf = pred;
            const isGlobalNs = nameResolver.namespaceName.length > 0;
            pred = x => {
                return sf(x) &&
                    (isGlobalNs || x.kind !== SymbolKind.Namespace) &&
                    (x.kind === SymbolKind.Namespace || util.ciStringContains(word, PhpSymbol.notFqn(x.name)));
            };

            Array.prototype.push.apply(items, keywordCompletionItems(this._getKeywords(traverser.clone()), word));
            const imports = await this._importedSymbols(nameResolver.rules, this._symbolFilter, word);
            let imported: PhpSymbol;

            for (let n = 0; n < imports.length; ++n) {
                imported = imports[n];
                if (imported.associated && imported.associated.length) {
                    importMap[imported.associated[0].name] = imported;
                }
                items.push(
                    await this._toCompletionItem(
                        imports[n],
                        useDeclarationHelper,
                        nameResolver.namespaceName,
                        isUnqualified,
                        fqnOffset,
                        qualifiedNameRule
                    ));
            }

        }

        const uniqueSymbols = new UniqueSymbolSet();
        const iterator = await this.symbolStore.match(word, pred);
        let limit = this.config.maxItems;
        let isIncomplete = false;

        for (let s of iterator) {
            if (importMap[s.name] || uniqueSymbols.has(s)) {
                continue;
            }

            uniqueSymbols.add(s);
            items.push(await this._toCompletionItem(
                s,
                useDeclarationHelper,
                nameResolver.namespaceName,
                isUnqualified,
                fqnOffset,
                qualifiedNameRule
            ));

            if (items.length >= limit) {
                isIncomplete = true;
                break;
            }
        }

        return <lsp.CompletionList>{
            items: items,
            isIncomplete: isIncomplete
        }

    }

    protected _useSymbolToUseDeclaration(s: PhpSymbol) {
        if (!s.associated) {
            return '';
        }

        const fqn = s.associated[0].name;
        let decl = `use ${fqn}`;
        const slashPos = fqn.lastIndexOf('\\') + 1;
        if (fqn.slice(-s.name.length) !== s.name) {
            //aliased
            decl += ` as ${s.name}`;
        }
        return decl;
    }

    protected abstract _getKeywords(traverser: ParseTreeTraverser): string[];

    protected async _importedSymbols(rules: PhpSymbol[], pred: Predicate<PhpSymbol>, text: string) {

        let filteredRules: PhpSymbol[] = [];
        let r: PhpSymbol;
        for (let n = 0, l = rules.length; n < l; ++n) {
            r = rules[n];
            if (r.associated && r.associated.length > 0 && util.ciStringContains(text, r.name)) {
                filteredRules.push(r);
            }
        }

        //lookup associated symbol for extra info
        let s: PhpSymbol | undefined;
        let merged: PhpSymbol;
        let imported: PhpSymbol[] = [];
        for (let n = 0, l = filteredRules.length; n < l; ++n) {
            r = filteredRules[n];
            if (!r.associated) {
                continue;
            }
            s = (await this.symbolStore.find(r.associated[0].name, pred)).shift();
            if (s) {
                merged = PhpSymbol.clone(s);
                merged.associated = r.associated;

                if (!merged.modifiers) {
                    merged.modifiers = SymbolModifier.None;
                }

                merged.modifiers |= SymbolModifier.Use;
                merged.name = r.name;
                imported.push(merged);
            } else {
                //not found but suggest it anyway as a namespace
                merged = PhpSymbol.clone(r);
                merged.kind = SymbolKind.Namespace;
                imported.push(merged);
            }
        }
        return imported;
    }

    protected async _toCompletionItem(
        s: PhpSymbol,
        useDeclarationHelper: UseDeclarationHelper,
        namespaceName: string,
        isUnqualified: boolean,
        fqnOffset: number,
        qualifiedNameRule: PhpSymbol | null
    ) {

        const item = <lsp.CompletionItem>{
            kind: symbolKindToLspSymbolKind(s.kind),
            label: ''
        }

        //todo remove this and use resolve provider
        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }

        const symbolNamespace = PhpSymbol.namespace(s.name);

        if (!isUnqualified) {
            item.label = s.name.slice(fqnOffset);
            if (qualifiedNameRule) {
                item.detail = this._useSymbolToUseDeclaration(qualifiedNameRule);
            }
        } else if (s.modifiers && (s.modifiers & SymbolModifier.Use) > 0) {
            //symbol is use decl
            //show the use decl as detail
            item.detail = this._useSymbolToUseDeclaration(s);
            item.label = PhpSymbol.notFqn(s.name);
        } else if (s.kind === SymbolKind.Namespace || (!namespaceName && !symbolNamespace) || (s.kind === SymbolKind.Constant && this._isMagicConstant(s.name))) {
            //symbols not namespaced and in global namespace context
            //and unqualified namespaces
            //and php magic constants
            //get fqn only
            item.label = s.name;
        } else if (namespaceName === symbolNamespace) {
            //symbol shares same namespace 
            //show the current namespace
            item.detail = `namespace ${namespaceName}`;
            item.label = PhpSymbol.notFqn(s.name);
        } else if (namespaceName && !symbolNamespace) {
            //symbol is in global namespace but the current namespace is not global
            //prefix with backslash
            //functions and const dont need prefix unless set in config
            item.label = s.name;
            if ((s.kind !== SymbolKind.Constant && s.kind !== SymbolKind.Function) || this.config.backslashPrefix) {
                item.insertText = '\\' + s.name;
            }
        } else if (this.config.addUseDeclaration && !useDeclarationHelper.findUseSymbolByName(s.name)) {
            //match on short name
            //add a use decl as additional text
            item.label = PhpSymbol.notFqn(s.name);
            item.detail = `use ${s.name}`;
            item.additionalTextEdits = [useDeclarationHelper.insertDeclarationTextEdit(s)];
        } else {
            //insert fqn
            item.insertText = '\\' + s.name;
            item.detail = s.name;
        }

        if (s.kind === SymbolKind.Function) {
            if (!item.insertText) {
                item.insertText = item.label;
            }
            //add signature
            //and configure to invoke parameter hints
            item.detail = s.name + PhpSymbol.signatureString(s);
            if (PhpSymbol.hasParameters(s)) {
                item.insertText += '($0)';
                item.insertTextFormat = lsp.InsertTextFormat.Snippet;
                item.command = triggerParameterHintsCommand;
            } else {
                item.insertText += '()';
            }

        } else if (s.kind === SymbolKind.Constant) {

            if (s.value) {
                item.detail = `${s.name} = ${s.value}`;
            }

        } else {
            //class, interface, trait
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

    protected _isNamePhrase(node: SyntaxNode) {
        return node.type === 'qualified_name';
    }

    /**
     * Caller determines whether namespaces should be included.
     * @param s 
     */
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

class InstanceOfTypeDesignatorCompletion extends AbstractNameCompletion {

    canSuggest(traverser: ParseTreeTraverser) {

        super.canSuggest(traverser);
        const parent = traverser.parent();
        const parentOfParent = traverser.parent();
        const parentOfParentOfParent = traverser.parent();
        let operator: null | SyntaxNode = null;

        return (parent != null && parent.type === 'namespace_name') &&
            (parentOfParent != null && parentOfParent.type === 'parentOfParent.type') &&
            (parentOfParentOfParent != null && (
                parentOfParentOfParent.type == 'binary_expression' &&
                (operator = parentOfParentOfParent.child(1)) != null && operator.type == 'instanceof'
            ));
    }

    protected _symbolFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Interface | SymbolKind.Namespace)) > 0 &&
            s.modifiers != null && !(s.modifiers & (SymbolModifier.Anonymous));
    }

    protected _getKeywords(traverser: ParseTreeTraverser):string[] {
        return [];
    }

}

class ClassTypeDesignatorCompletion extends AbstractNameCompletion {

    private static _keywords = [
        'class', 'static', 'namespace'
    ];

    canSuggest(traverser: ParseTreeTraverser) {
        super.canSuggest(traverser);
        const node = traverser.node;
        const parent = traverser.parent();
        const parentOfParent = traverser.parent();

        return (node !== null && node.type === 'new') ||
            (
                (parent !== null && parent.type === 'qualified_name') &&
                (parentOfParent !== null && parentOfParent.type === 'object_creation_expression')
            );
    }

    protected _symbolFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Namespace)) > 0 &&
            !(s.modifiers != null && s.modifiers & (SymbolModifier.Anonymous | SymbolModifier.Abstract));
    }

    protected _getKeywords(traverser: ParseTreeTraverser) {

        if (traverser.ancestor(this._isQualifiedName)) {
            return ClassTypeDesignatorCompletion._keywords;
        }
        return [];
    }

    protected async _toCompletionItem(
        s: PhpSymbol,
        useDeclarationHelper: UseDeclarationHelper,
        namespaceName: string,
        isUnqualified: boolean,
        fqnOffset: number,
        qualifiedNameRule: PhpSymbol
    ) {

        let item = await super._toCompletionItem(s, useDeclarationHelper, namespaceName, isUnqualified, fqnOffset, qualifiedNameRule);
        let aggregate = new TypeAggregate(this.symbolStore, s);
        let constructor = await aggregate.firstMember(this._isConstructor);
        if (item.kind !== lsp.CompletionItemKind.Module) { //namespace
            item.kind = lsp.CompletionItemKind.Constructor;
        }
        if (constructor && PhpSymbol.hasParameters(constructor)) {
            if (!item.insertText) {
                item.insertText = item.label;
            }
            item.insertText += '($0)';
            item.insertTextFormat = lsp.InsertTextFormat.Snippet;
            item.command = triggerParameterHintsCommand;
        }
        return item;

    }

    private _isConstructor(s: PhpSymbol) {
        return s.kind === SymbolKind.Constructor || (s.kind === SymbolKind.Method && s.name.toLowerCase() === '__construct');
    }

    private _isQualifiedName(node: SyntaxNode) {
        return node.type == 'qualified_name';
    }

}

class SimpleVariableCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    canSuggest(traverser: ParseTreeTraverser) {
        const node = traverser.node;
        const parent = traverser.parent();

        if (node === null) {
            return false;
        }

        if (node.type === '$') {
            return true;
        }

        if (node.type === 'simple_variable') {
            return true;
        }

        if (node.type !== 'name') {
            return false;
        }

        return parent != null && ['$', 'variable_name'].includes(parent.type);
    }

    async completions(traverser: ParseTreeTraverser, word: string, lineSubstring: string) {

        if (!word) {
            return noCompletionResponse;
        }

        let scope = traverser.scope;

        if (!scope || !scope.location) {
            return noCompletionResponse;
        }

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
        let varTable = await this._varTypeMap(refScope);

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
            detail: varTable[s.name] || ''
        }

        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }

        return item;

    }

    private async _varTypeMap(s: Scope | undefined) {

        let map: { [index: string]: string } = {};

        if (!s || !s.children) {
            return {};
        }

        let ref: Reference;
        for (let n = 0, l = s.children.length; n < l; ++n) {
            ref = s.children[n] as Reference;
            if (ref.kind === SymbolKind.Variable || ref.kind === SymbolKind.Parameter) {
                const type = await TypeString.resolve(ref.type);
                map[ref.name] = TypeString.merge(map[ref.name], type);
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
        super.canSuggest(traverser);
        const parent = traverser.parent();

        return parent != null && parent.type === 'namespace_name' &&
            traverser.ancestor(this._isNamePhrase) !== null;
    }

    async completions(traverser: ParseTreeTraverser, word: string, lineSubstring: string) {

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
        return (s.kind & (SymbolKind.Class | SymbolKind.Function | SymbolKind.Constant | SymbolKind.Namespace)) > 0 &&
            s.modifiers != undefined && !(s.modifiers & SymbolModifier.Anonymous);
    }

}

abstract class MemberAccessCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    abstract canSuggest(traverser: ParseTreeTraverser): boolean;

    async completions(traverser: ParseTreeTraverser, word: string) {
        let scopedAccessExpr = traverser.ancestor(this._isMemberAccessExpr);
        let scopePhrase = traverser.nthChild(0);
        let type = await this._resolveType(traverser);
        let typeNames = TypeString.atomicClassArray(type);

        if (!typeNames.length) {
            return noCompletionResponse;
        }

        let nameResolver = traverser.nameResolver;
        let classAggregateType = await TypeAggregate.create(this.symbolStore, nameResolver.className);
        let typeName: string;
        let fn: Predicate<PhpSymbol>;
        let typeAggregate: TypeAggregate | null = null;
        let symbols: PhpSymbol[] = [];

        for (let n = 0, l = typeNames.length; n < l; ++n) {
            typeName = typeNames[n];
            if (classAggregateType && classAggregateType.name.toLowerCase() === typeName.toLowerCase()) {
                typeAggregate = classAggregateType;
            } else {
                typeAggregate = await TypeAggregate.create(this.symbolStore, typeName);
            }

            if (!typeAggregate) {
                continue;
            }

            fn = await this._createMemberPredicate(typeName, word, classAggregateType);
            Array.prototype.push.apply(symbols, await typeAggregate.members(MemberMergeStrategy.Documented, fn));
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

    private async _resolveType(traverser: ParseTreeTraverser): Promise<string> {

        //assumed that traverser is on the member scope node
        let node: SyntaxNode | null = null;
        let arrayDereference = 0;
        let ref: Reference | null = null;

        while (true) {
            node = traverser.node;

            if (node == null) {
                break;
            }

            switch (node.type) {
                case 'dereferencable_expression':
                    if (traverser.nthChild(0)) {
                        continue;
                    }
                    break;

                case 'qualified_name':
                case 'variable_name':
                case 'relative_scope':
                    ref = traverser.reference;
                    break;

                case 'scoped_call_expression':
                case 'member_access_expression':
                case 'scoped_property_access_expression':
                case 'class_constant_access_expression':
                    if (traverser.child(this._isMemberName)) {
                        ref = traverser.reference;
                    }
                    break;

                case 'conditional_expression':
                case 'augmented_assignment_expression':
                case 'assignment_expression':
                case 'yield_expression':
                case 'binary_expression':
                case 'include_expression':
                case 'include_once_expression':
                case 'require_expression':
                case 'require_once_expression':
                case 'clone_expression':
                case 'exponentiation_expression':
                case 'unary_op_expression':
                case 'cast_expression':
                    if (traverser.child(node => node.childCount > 0)) {
                        continue;
                    }
                    break;

                case 'object_creation_expression':
                    if (traverser.child(this._isClassTypeDesignator) && traverser.child(ParsedDocument.isNamePhrase)) {
                        ref = traverser.reference;
                    }
                    break;

                case 'assignment_expression':
                    if (traverser.nthChild(0)) {
                        continue;
                    }
                    break;

                case 'function_call_expression':
                    if (traverser.nthChild(0)) {
                        ref = traverser.reference;
                    }
                    break;

                case 'subscript_expression':
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

        let type = await TypeString.resolve(await this.symbolStore.referenceToTypeString(ref));
        while (arrayDereference--) {
            type = TypeString.arrayDereference(type);
        }

        return type;

    }

    protected abstract async _createMemberPredicate(
        scopeName: string, word: string, classContext: TypeAggregate | null
    ): Promise<Predicate<PhpSymbol>>;

    protected _isMemberAccessExpr(node: SyntaxNode) {
        return [
            'scoped_call_expression',
            'class_constant_access_expression',
            'scoped_property_access_expression',
            'member_access_expression',
            'member_call_expression',
        ].includes(node.type);
    }

    protected _toCompletionItem(s: PhpSymbol) {
        switch (s.kind) {
            case SymbolKind.ClassConstant:
                return this.toClassConstantCompletionItem(s);
            case SymbolKind.Method:
                return this.toMethodCompletionItem(s);
            case SymbolKind.Property:
                return this.toPropertyCompletionItem(s);
            default:
                throw Error('Invalid Argument');
        }
    }

    protected toMethodCompletionItem(s: PhpSymbol) {

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

        if (PhpSymbol.hasParameters(s)) {
            item.insertText = s.name + '($0)';
            item.insertTextFormat = lsp.InsertTextFormat.Snippet;
            item.command = triggerParameterHintsCommand;
        } else {
            item.insertText = s.name + '()';
        }

        return item;
    }

    protected toClassConstantCompletionItem(s: PhpSymbol) {
        let item = <lsp.CompletionItem>{
            kind: lsp.CompletionItemKind.Value, //@todo use Constant
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


    protected toPropertyCompletionItem(s: PhpSymbol) {
        let item = <lsp.CompletionItem>{
            kind: lsp.CompletionItemKind.Property,
            label: s.modifiers !== undefined && (s.modifiers & SymbolModifier.Static) > 0 ?
                s.name : s.name.slice(1), //remove $
            detail: PhpSymbol.type(s)
        }

        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }

        return item;
    }

    private _isMemberName(node: SyntaxNode) {
        return node.type === 'member_name';
    }

    private _isClassTypeDesignator(node: SyntaxNode): boolean {
        return ['qualified_name', 'new_variable'].includes(node.type) &&
            node.parent !== null && [
                'object_creation_expression',
                'binary_expression',
            ].includes(node.parent.type);
    }

}

class ScopedAccessCompletion extends MemberAccessCompletion {


    canSuggest(traverser: ParseTreeTraverser): boolean {
        const scopedAccessPhrases = [
            'class_constant_access_expression',
            'scoped_property_access_expression',
            'scoped_call_expression',
        ];
        const node = traverser.node;
        const parent = traverser.parent();
        const parentOfParent = traverser.parent();

        if (node == null) {
            return false;
        }

        if (node.type === '::') {
            return parent != null && scopedAccessPhrases.includes(parent.type);
        }

        if (node.type == '$') {
            return parent !== null && parentOfParent !== null && (
                parent.type == 'variable_name' && parentOfParent.type == 'scoped_property_access_expression'
            );
        }

        if (node.type !== 'name') {
            return false;
        }

        return parentOfParent != null && scopedAccessPhrases.includes(parentOfParent.type);
    }

    protected async _createMemberPredicate(
        scopeName: string, word: string, classContext: TypeAggregate | null
    ): Promise<Predicate<PhpSymbol>> {
        if (classContext && scopeName.toLowerCase() === classContext.name.toLowerCase()) {
            //public, protected, private
            return (x) => {
                return x.modifiers !== undefined && (x.modifiers & SymbolModifier.Static) > 0 &&
                    util.ciStringContains(word, x.name);
            };
        } else if (classContext && await classContext.isBaseClass(scopeName)) {
            //public, protected
            //looking for non static here as well to handle parent keyword
            return (x) => {
                return !(x.modifiers !== undefined && x.modifiers & SymbolModifier.Private) &&
                    util.ciStringContains(word, x.name);
            };

        } else if (classContext && await classContext.isAssociated(scopeName)) {
            //public, protected
            return (x) => {
                return x.modifiers !== undefined && (x.modifiers & SymbolModifier.Static) > 0 &&
                    !(x.modifiers & SymbolModifier.Private) &&
                    util.ciStringContains(word, x.name);
            };

        } else {
            //public
            const mask = SymbolModifier.Static | SymbolModifier.Public;
            return (x) => {
                return x.modifiers !== undefined && (x.modifiers & mask) === mask &&
                    util.ciStringContains(word, x.name);
            };
        }
    }

}

class ObjectAccessCompletion extends MemberAccessCompletion {

    canSuggest(traverser: ParseTreeTraverser) {
        const parent = traverser.parent();
        const node = traverser.node;
        const objectTypes = [
            'new_variable',
            'member_access_expression',
            'member_call_expression',
        ];

        if (node === null) {
            return false;
        }

        if (objectTypes.includes(node.type)) {
            return true;
        }

        if (parent === null) {
            return false;
        }

        if (node !== null && ['->'].includes(node.type)) {
            return objectTypes.includes(parent.type);
        }

        return parent.type === 'member_name';

    }

    protected async _createMemberPredicate(
        scopeName: string, word: string, classContext: TypeAggregate | null
    ): Promise<Predicate<PhpSymbol>> {

        //php allows static methods to be accessed with ->
        if (classContext && scopeName.toLowerCase() === classContext.name.toLowerCase()) {
            //public, protected, private
            return (x) => {
                return util.ciStringContains(word, x.name);
            };
        } else if (classContext && await classContext.isAssociated(scopeName)) {
            //public, protected
            const mask = SymbolModifier.Private;
            return (x) => {
                return x.modifiers !== undefined &&
                    !(x.modifiers & mask) && util.ciStringContains(word, x.name);
            };

        } else {
            //public
            const mask = SymbolModifier.Protected | SymbolModifier.Private;
            return (x) => {
                return x.modifiers !== undefined &&
                    !(x.modifiers & mask) && util.ciStringContains(word, x.name);
            };
        }
    }

}

class TypeDeclarationCompletion extends AbstractNameCompletion {

    private static _keywords = [
        'self', 'array', 'callable', 'bool', 'float', 'int', 'string'
    ];

    canSuggest(traverser: ParseTreeTraverser) {
        super.canSuggest(traverser);
        return traverser.node !== null && [
            'name',
            '\\',
            'array',
            'callable',
        ].includes(traverser.node.type) &&
            traverser.ancestor(this._isTypeDeclaration) !== null;
    }

    protected _getKeywords(traverser: ParseTreeTraverser) {
        return TypeDeclarationCompletion._keywords;
    }

    protected _symbolFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Interface | SymbolKind.Namespace)) > 0;
    }

    private _isTypeDeclaration(node: SyntaxNode) {
        return node.type === 'type_declaration';
    }

}

class ClassBaseClauseCompletion extends AbstractNameCompletion {

    canSuggest(traverser: ParseTreeTraverser) {
        super.canSuggest(traverser);
        return traverser.ancestor(this._isClassBaseClause) !== null;
    }

    protected _getKeywords(traverser: ParseTreeTraverser):string[] {
        return [];
    }

    protected _symbolFilter(s: PhpSymbol) {
        return (s.kind & (SymbolKind.Class | SymbolKind.Namespace)) > 0 &&
            s.modifiers !== undefined && !(s.modifiers & SymbolModifier.Final);
    }

    private _isClassBaseClause(node: SyntaxNode) {
        return node.type === 'class_base_clause';
    }

}

class InterfaceClauseCompletion extends AbstractNameCompletion {

    canSuggest(traverser: ParseTreeTraverser) {
        super.canSuggest(traverser);
        return traverser.ancestor(this._isInterfaceClause) !== null;

    }

    protected _getKeywords(traverser: ParseTreeTraverser):string[] {
        return [];
    }

    protected _symbolFilter(s: PhpSymbol) {
        return s.kind === SymbolKind.Interface || s.kind === SymbolKind.Namespace;
    }

    private _isInterfaceClause(node: SyntaxNode) {
        return [
            'class_interface_clause',
            'interface_base_clause',
        ].includes(node.type);
    }

}

class TraitUseClauseCompletion extends AbstractNameCompletion {

    canSuggest(traverser: ParseTreeTraverser) {
        super.canSuggest(traverser);
        const parent = traverser.parent();
        const parentOfParent = traverser.parent();
        return traverser.ancestor(this._isNamePhrase) !== null &&
            parent !== null && parent.type === 'qualified_name' &&
            parentOfParent !== null && parentOfParent.type === 'trait_use_clause';
    }

    protected _getKeywords(traverser: ParseTreeTraverser):string[] {
        return [];
    }

    protected _symbolFilter(s: PhpSymbol) {
        return s.kind === SymbolKind.Trait || s.kind === SymbolKind.Namespace;
    }

}

class NamespaceDefinitionCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    canSuggest(traverser: ParseTreeTraverser) {
        if (traverser.node && traverser.node.type === '\\') {
            traverser.prevToken();
        }
        return traverser.ancestor(this._isNamespaceDefinition) !== null;
    }

    async completions(traverser: ParseTreeTraverser, word: string) {

        const items: lsp.CompletionItem[] = [];
        const uniqueSymbols = new UniqueSymbolSet();
        //namespaces always match on fqn
        const matches = await this.symbolStore.match(word, this._symbolFilter);
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

    private _isNamespaceDefinition(node: SyntaxNode) {
        return node.type === 'namespace_definition';
    }


}

class NamespaceUseClauseCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    canSuggest(traverser: ParseTreeTraverser) {
        if (traverser.node && traverser.node.type === '\\') {
            traverser.prevToken();
        }
        const parent = traverser.parent();
        const parentOfParent = traverser.parent();

        if (parent === null || parentOfParent === null) {
            return false;
        }

        return parent.type === 'namespace_name' &&
            [
                'namespace_use_declaration',
                'namespace_use_clause',
            ].includes(parentOfParent.type);
    }

    async completions(traverser: ParseTreeTraverser, word: string) {

        let items: lsp.CompletionItem[] = [];
        let namespaceUseDecl = traverser.ancestor(this._isNamespaceUseDeclaration);

        if (!word) {
            return noCompletionResponse;
        }

        const kindMask = this._modifierToSymbolKind(traverser.child(this._isModifier));
        const pred = (x: PhpSymbol) => {
            return (x.kind & kindMask) > 0 && x.modifiers !== undefined && !(x.modifiers & SymbolModifier.Use);
        }

        const matches = await this.symbolStore.match(word, pred);
        const uniqueSymbols = new UniqueSymbolSet();
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

        return <lsp.CompletionList>{
            isIncomplete: isIncomplete,
            items: items
        }

    }

    private _toCompletionItem(s: PhpSymbol, lcWord: string, fqnOffset: number) {
        const didMatchOnFqn = s.name.slice(0, lcWord.length).toLowerCase() === lcWord;
        let item = <lsp.CompletionItem>{
            kind: symbolKindToLspSymbolKind(s.kind),
            label: didMatchOnFqn ? s.name.slice(fqnOffset) : PhpSymbol.notFqn(s.name)
        }
        if (s.kind !== SymbolKind.Namespace && !didMatchOnFqn) {
            item.detail = s.name;
            item.insertText = s.name;
        }

        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }

        return item;
    }

    private _isNamespaceUseDeclaration(node: SyntaxNode) {
        return node.type === 'namespace_use_declaration';
    }

    private _modifierToSymbolKind(token: SyntaxNode | null) {

        const defaultKindMask = SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait | SymbolKind.Namespace;

        if (!token) {
            return defaultKindMask;
        }

        switch (token.type) {
            case 'function':
                return SymbolKind.Function | SymbolKind.Namespace;
            case 'const':
                return SymbolKind.Constant | SymbolKind.Namespace;
            default:
                return defaultKindMask;
        }
    }

    private _isModifier(node: SyntaxNode) {
        switch (node.type) {
            case 'class':
            case 'function':
            case 'const':
                return true;
            default:
                return false;
        }
    }

}

class NamespaceUseGroupClauseCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    canSuggest(traverser: ParseTreeTraverser) {
        if (traverser.node && traverser.node.type === '\\') {
            traverser.prevToken();
        }
        const parent = traverser.parent();
        const parentOfParent = traverser.parent();

        if (parent === null || parentOfParent === null) {
            return false;
        }

        return parent.type === 'namespace_name' && [
            'namespace_use_group_clause_1',
            'namespace_use_group_clause_2',
        ].includes(parentOfParent.type);
    }

    async completions(traverser: ParseTreeTraverser, word: string) {

        let items: lsp.CompletionItem[] = [];
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

        let pred = (x: PhpSymbol) => {
            return (x.kind & kindMask) > 0 && x.modifiers !== undefined && !(x.modifiers & SymbolModifier.Use);
        };

        let matches = await this.symbolStore.match(word, pred);
        let uniqueSymbols = new UniqueSymbolSet();
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

        return <lsp.CompletionList>{
            isIncomplete: isIncomplete,
            items: items
        }

    }

    private _toCompletionItem(s: PhpSymbol, fqnOffset: number) {
        let item = <lsp.CompletionItem>{
            kind: symbolKindToLspSymbolKind(s.kind),
            label: s.name.slice(fqnOffset)
        };

        //todo remove and implement resolve provider
        if (s.doc && s.doc.description) {
            item.documentation = s.doc.description;
        }

        return item;
    }

    private _isNamespaceUseGroupClause(node: SyntaxNode) {
        return [
            'namespace_use_group_clause_1',
            'namespace_use_group_clause_2',
        ].includes(node.type);
    }

    private _isNamespaceUseDeclaration(node: SyntaxNode) {
        return node.type === 'namespace_use_declaration';
    }

    private _isModifier(node: SyntaxNode) {
        switch (node.type) {
            case 'class':
            case 'function':
            case 'const':
                return true;
            default:
                return false;
        }
    }

    private _isNamespaceName(node: SyntaxNode) {
        return node.type === 'namespace_name';
    }

    private _modifierToSymbolKind(modifier: SyntaxNode | null) {

        const defaultKindMask = SymbolKind.Class | SymbolKind.Interface | SymbolKind.Trait | SymbolKind.Namespace;

        if (!modifier) {
            return defaultKindMask;
        }

        switch (modifier.type) {
            case 'function':
                return SymbolKind.Function | SymbolKind.Namespace;
            case 'const':
                return SymbolKind.Constant | SymbolKind.Namespace;
            default:
                return defaultKindMask;
        }
    }

}

class DeclarationBodyCompletion implements CompletionStrategy {

    constructor(public config: CompletionOptions) { }

    private static _phraseTypes = [
        'class_const_declaration', 'property_declaration', 'method_declaration',
        'constructor_declaration', 'destructor_declaration', 'trait_use_clause',
    ];

    private static _keywords = [
        'var', 'public', 'private', 'protected', 'final', 'function', 'abstract', 'use'
    ];

    canSuggest(traverser: ParseTreeTraverser) {
        const parent = traverser.parent();
        const parentOfParent = traverser.parent();
        const parentOfParentOfParent = traverser.parent();

        return parent !== null && (
            DeclarationBodyCompletion._phraseTypes.includes(parent.type) ||
            parent.type === 'ERROR' && (
                parentOfParent !== null && (
                    DeclarationBodyCompletion._phraseTypes.includes(parentOfParent.type) ||
                    parentOfParent.type === 'ERROR' && (
                        parentOfParentOfParent !== null &&
                        DeclarationBodyCompletion._phraseTypes.includes(parentOfParentOfParent.type)
                    )
                )
            )
        );
    }

    async completions(traverser: ParseTreeTraverser, word: string) {
        return <lsp.CompletionList>{
            items: keywordCompletionItems(DeclarationBodyCompletion._keywords, word)
        }
    }

}

class MethodDeclarationHeaderCompletion implements CompletionStrategy {

    private static readonly MAGIC_METHODS: { [name: string]: string } = {
        '__construct': `__construct($1)\n{\n\t$0\n\\}`,
        '__destruct': `__destruct()\n{\n\t$0\n\\}`,
        '__call': `__call(\\$name, \\$arguments)\n{\n\t$0\n\\}`,
        '__callStatic': `__callStatic(\\$name, \\$arguments)\n{\n\t$0\n\\}`,
        '__get': `__get(\\$name)\n{\n\t$0\n\\}`,
        '__set': `__set(\\$name, \\$value)\n{\n\t$0\n\\}`,
        '__isset': `__isset(\\$name)\n{\n\t$0\n\\}`,
        '__unset': `__unset(\\$name)\n{\n\t$0\n\\}`,
        '__sleep': `__sleep()\n{\n\t$0\n\\}`,
        '__wakeup': `__wakeup()\n{\n\t$0\n\\}`,
        '__toString': `__toString()\n{\n\t$0\n\\}`,
        '__invoke': `__invoke($1)\n{\n\t$0\n\\}`,
        '__set_state': `__set_state(\\$properties)\n{\n\t$0\n\\}`,
        '__clone': `__clone()\n{\n\t$0\n\\}`,
        '__debugInfo': `__debugInfo()\n{\n\t$0\n\\}`
    };

    constructor(public config: CompletionOptions, public symbolStore: SymbolStore) { }

    canSuggest(traverser: ParseTreeTraverser) {
        let nameResolver = traverser.nameResolver;
        let thisSymbol = nameResolver.class;
        const parent = traverser.parent();
        const parentOfParent = traverser.parent();
        return parent !== null && parent.type === 'name' &&
            // TODO: Fix this
            parentOfParent !== null && parentOfParent.type === 'method_declaration_header' &&
            thisSymbol !== undefined;
    }

    async completions(traverser: ParseTreeTraverser, word: string) {

        let memberDecl = traverser.ancestor(this._isMethodDeclarationHeader);
        let modifiers = SymbolReader.modifierListToSymbolModifier(traverser.child(this._isMemberModifierList));

        if (modifiers & (SymbolModifier.Private | SymbolModifier.Abstract)) {
            return noCompletionResponse;
        }

        modifiers &= (SymbolModifier.Public | SymbolModifier.Protected);
        let nameResolver = traverser.nameResolver;
        let classSymbol = nameResolver.class;
        let existingMethods = PhpSymbol.filterChildren(classSymbol, this._isMethod);
        let existingMethodNames = new Set<string>(existingMethods.map<string>(this._toName));

        let fn = (x: PhpSymbol) => {
            return x.kind === SymbolKind.Method &&
                (!modifiers || (x.modifiers !== undefined && (x.modifiers & modifiers) > 0)) &&
                !(x.modifiers !== undefined && (x.modifiers & (SymbolModifier.Final | SymbolModifier.Private))) &&
                !existingMethodNames.has(x.name.toLowerCase()) &&
                util.ciStringContains(word, x.name);
        }

        const aggregate = new TypeAggregate(this.symbolStore, classSymbol, true);
        const matches = await aggregate.members(MemberMergeStrategy.Documented, fn);
        let isIncomplete = matches.length > this.config.maxItems;
        const limit = Math.min(this.config.maxItems, matches.length);
        const items: lsp.CompletionItem[] = [];
        let s: PhpSymbol;

        for (let n = 0; n < limit; ++n) {
            s = matches[n];
            if (s.name && s.name[0] === '_') {
                existingMethodNames.add(s.name);
            }
            items.push(this._toCompletionItem(s));
        }

        Array.prototype.push.apply(items, this._magicMethodCompletionItems(word, existingMethodNames));

        return <lsp.CompletionList>{
            isIncomplete: isIncomplete,
            items: items
        }

    }

    private _magicMethodCompletionItems(word: string, excludeSet: Set<string>) {
        let name: string;
        const items: lsp.CompletionItem[] = [];
        const keys = Object.keys(MethodDeclarationHeaderCompletion.MAGIC_METHODS);
        for (let n = 0; n < keys.length; ++n) {
            name = keys[n];
            if (!util.ciStringContains(word, name) || excludeSet.has(name)) {
                continue;
            }

            items.push({
                kind: lsp.CompletionItemKind.Method,
                label: name,
                insertText: MethodDeclarationHeaderCompletion.MAGIC_METHODS[name],
                insertTextFormat: lsp.InsertTextFormat.Snippet,
            });

        }
        return items;
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
            detail: `${s.scope}::${s.name}`
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

    private _isMethodDeclarationHeader(node: SyntaxNode) {
        // TODO: Fix this please method_declaration_header does not exist
        return node.type === 'method_declaration_header';
    }

    private _isMemberModifierList(node: SyntaxNode) {
        // TODO: Fix this please member_modifier_list does not exist
        return node.type === 'member_modifier_list';
    }

    private _isMethod(s: PhpSymbol) {
        return s.kind === SymbolKind.Method;
    }

    private _toName(s: PhpSymbol) {
        return s.name.toLowerCase();
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
