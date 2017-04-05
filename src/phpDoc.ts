/* Copyright (c) Ben Mewburn ben@mewburn.id.au
 * Licensed under the MIT Licence.
 */

'use strict';

export namespace PhpDocParser {

    const stripPattern: RegExp = /^\/\*\*[ \t]*|\s*\*\/$|^[ \t]*\*[ \t]*/mg;
    const tagBoundaryPattern: RegExp = /(?:\r\n|\r|\n)(?=@)/;
    const summaryBoundaryPattern: RegExp = /\.(?:\r\n|\r|\n)|(?:\r\n|\r|\n){2}/;
    const methodParamPartBoundaryPattern: RegExp = /\s*,\s*|\s+/;
    const paramOrPropertyPattern = /^(@param|@property|@property-read|@property-write)\s+(\S+)\s+(\$\S+)\s*([^]*)$/;
    const varPattern = /^(@var)\s+(\S+)\s+(\$\S+)?\s*([^]*)$/;
    const returnPattern = /^(@return)\s+(\S+)\s*([^]*)$/;
    const methodPattern = /^(@method)\s+(\S+\s+)?(\S+)\(\s*([^]*)\s*\)(?!\[)\s*([^]*)$/;

    export function parse(input: string) {

        if (!input) {
            return null;
        }

        let stripped = input.replace(stripPattern, '');
        let split = stripped.split(tagBoundaryPattern);
        let text: string = '';

        if (split[0] && split[0][0] !== '@') {
            text = split.shift().trim();
        }

        let match: RegExpMatchArray;
        let tagString: string;
        let tags: Tag[] = [];
        let tag:Tag;

        while (tagString = split.shift()) {

            //parse @param, @var, @property*, @return, @method tags
            tag = parseTag(tagString);
            if(tag){
                tags.push(tag);
            }

        }

        //must have at least text or a tag
        if (!text && !tags.length) {
            return null;
        }

        return new PhpDoc(text, tags);

    }

    function parseTag(text:string){

        let substring = text.slice(0, 4);
        let match: RegExpMatchArray;      

        switch(substring){
            case '@par':
            case '@pro':
                if((match = text.match(paramOrPropertyPattern))){
                    return typeTag(match[1], match[2], match[3], match[4]);
                }
                return null;
            case '@var':
                if((match = text.match(varPattern))){
                    return typeTag(match[1], match[2], match[3], match[4]);
                }
                return null;
            case '@ret':
                if((match = text.match(returnPattern))){
                    return typeTag(match[1], match[2], '', match[3]);
                }
                return null;
            case '@met':
                if((match = text.match(methodPattern))){
                    return methodTag(match[5], match[6], match[7], methodParameters(match[8]), match[9]);
                }
                return null;
            default:
                return null;
        }


    }

    function typeTag(tagName: string, typeString: string, name: string, description: string) {
        return {
            tagName: tagName,
            typeString: typeString,
            name: name ? name : '',
            description: description ? description : ''
        };
    }

    function methodTag(tagName: string, returnTypeString: string, name: string,
        parameters: MethodTagParam[], description: string) {
        return {
            tagName: tagName,
            typeString: returnTypeString ? returnTypeString : 'void',
            name: name,
            parameters: parameters,
            description: description ? description : ''
        };
    }

    function methodParameters(input: string): MethodTagParam[] {

        if (!input) {
            return [];
        }

        let params: MethodTagParam[] = [];
        let paramSplit = input.split(methodParamPartBoundaryPattern);
        let typeString: string, name: string;

        while (paramSplit.length) {

            name = paramSplit.pop();
            typeString = paramSplit.pop();

            if (name && typeString) {
                params.push({
                    typeString: typeString,
                    name: name
                });
            }

        }

        return params.reverse();
    }

}

export interface MethodTagParam {
    typeString: string;
    name: string;
}

export interface Tag {
    tagName: string;
    name: string;
    description: string;
    typeString: string,
    parameters?: MethodTagParam[]
}

export class PhpDoc {

    constructor(public text:string, public tags: Tag[]) { }

    get returnTag() {
        return this.tags.find(PhpDoc.isReturnTag);
    }

    get propertyTags() {
        return this.tags.filter(PhpDoc.isPropertyTag);
    }

    get methodTags() {
        return this.tags.filter(PhpDoc.isMethodTag);
    }

    get varTags() {
        return this.tags.filter(PhpDoc.isVarTag);
    }

    findParamTag(name: string) {
        let fn = (x) => {
            return x.tagName === '@param' && x.name === name;
        };
        return this.tags.find(fn);

    }

    findVarTag(name: string) {
        let fn = (x) => {
            return x.tagName === '@var' && (!x.name || name === x.name);
        };
        return this.tags.find(fn);
    }

}

export namespace PhpDoc {

    export function isPropertyTag(t: Tag) {
        return t.tagName.indexOf('@property') === 0;
    }

    export function isReturnTag(t: Tag) {
        return t.tagName === '@return';
    }

    export function isMethodTag(t: Tag) {
        return t.tagName === '@method';
    }

    export function isVarTag(t:Tag){
        return t.tagName === '@var';
    }

}