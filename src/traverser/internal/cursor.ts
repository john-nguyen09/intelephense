import { Stack } from "./stack";

export interface CursorNode<T> {
    node: T | null;
    index: number;
};

export class Cursor<T> {
    public depth: number = 0;
    private stack: Stack<CursorNode<T>> = new Stack<CursorNode<T>>({
        node: null,
        index: -1,
    });

    moveDown(node: T) {
        this.depth++;
        this.stack.push({ node, index: 0 });
    }

    moveUp() {
        this.depth--;
        this.stack.pop();
    }

    moveNext() {
        this.stack.peek().index++;
    }

    get parent() {
        return this.stack.peek().node;
    }

    get index() {
        return this.stack.peek().index;
    }

    toArray(): T[] {
        return (<T[]>this.stack.toArray().map(cursorNode => {
            return cursorNode.node;
        }).filter(node => {
            return node !== null;
        }));
    }
}