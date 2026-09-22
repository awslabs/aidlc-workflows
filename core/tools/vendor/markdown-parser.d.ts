// Minimal source-position API used by aidlc-lib; the runtime is vendored beside this file.
export interface Point {
	line: number;
	column: number;
	offset: number;
}

export interface Token {
	type: string;
	start: Point;
	end: Point;
	_spread?: boolean;
	_container?: boolean;
}

export interface TokenizeContext {
	sliceSerialize(token: Token): string;
}

export type Event = ["enter" | "exit", Token, TokenizeContext];
export type Chunk = string | number;
export type Extension = Record<string, unknown>;

export function parse(options?: { extensions?: Extension[] }): {
	document(): { write(chunks: Chunk[]): Event[] };
};
export function preprocess(): (value: string, encoding?: string, end?: boolean) => Chunk[];
export function postprocess(events: Event[]): Event[];
export function gfm(): Extension;
export function normalizeIdentifier(value: string): string;
