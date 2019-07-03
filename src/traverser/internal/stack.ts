export class Stack<T> {
    private items: T[] = [];
    private top: number = 0;

    constructor(item: T) {
        this.items = [item];
    }

    push(item: T) {
        this.top++;
        if (this.top < this.items.length) {
            this.items[this.top] = item;
        } else {
            this.items.push(item);
        }
    }

    pushArrayReverse(items: T[]) {
        for (let i = items.length - 1; i >= 0; i--) {
            this.push(items[i]);
        }
    }

    pop() {
        const item = this.peek();
        this.top--;
        return item;
    }

    peek() {
        return this.items[this.top];
    }

    isEmpty() {
        return -1 === this.top;
    }

    toArray(offset?: number) {
        if (typeof offset === 'undefined') {
            offset = 0;
        }

        return this.items.slice(offset, this.top);
    }
}