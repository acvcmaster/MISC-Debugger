import { EventEmitter } from 'events';

export interface FileAccessor {
	readFile(path: string): Promise<string>;
}

export interface ProgramStartResponse {
	hasError: boolean;
	error?: string;
}

export interface RuntimeBreakpoint {
	verified: boolean;
	line: number;
	id: number;
}

export interface RuntimeStackframe {
	index: number;
	name: string;
	file: string;
	line: number;
}

export interface RuntimeStackframes {
	frames: RuntimeStackframe[];
	count: number;
}

export class RuntimeAdapter extends EventEmitter {
	constructor(private fileAccessor: FileAccessor) {
		super();
	}

	sourcePath: string | undefined;
	sourceText: string | undefined;
	sourceLines: string[] | undefined;

	// eslint-disable-next-line @typescript-eslint/naming-convention
	__mockLine = 0;

	public start(path: string, stopAtEntry = false): Promise<ProgramStartResponse> {
		return new Promise(async (resolve, _) => {
			this.sourcePath = path;
			this.sourceText = await this.fileAccessor.readFile(this.sourcePath);
			this.sourceLines = this.sourceText?.split(/\r?\n/);

			this.sendEvent('stopOnEntry');
			await this.printLine();
			resolve({ hasError: false });
			// resolve({ hasError: true, error: 'Could not compile source. Errors have been found.' });
		});
	}

	public clearBreakpoints(): Promise<void> {
		return new Promise((resolve, _) => {
			resolve();
		});
	}

	public setBreakPoint(line: number): RuntimeBreakpoint | PromiseLike<RuntimeBreakpoint> {
		return new Promise((resolve, _) => {
			resolve({ verified: false, line, id: line });
		});
	}

	public step(): Promise<boolean> {
		return new Promise(async (resolve, _) => {
			if (this.__mockLine < (this.sourceLines?.length || 0) - 1) {
				this.__mockLine++;
				this.sendEvent('stopOnStep');
				await this.printLine();
				resolve(false);
			} else {
				this.sendEvent('end');
				resolve(true);
			}
		});
	}

	public getStackFrames(): Promise<RuntimeStackframes> {
		return new Promise(async (resolve, _) => {
			resolve({
				frames: [{
					index: 0,
					name: `Line ${this.__mockLine}`,
					file: this.sourcePath || '',
					line: this.__mockLine
				}],
				count: 1
			});
		});
	}

	private getLineInformation(): Promise<{ line: number; column?: number }> {
		return new Promise((resolve, _) => {
			// query backend for line
			resolve({ line: this.__mockLine });
		});
	}

	private async printLine() {
		const lineInformation = await this.getLineInformation();
		this.sendEvent('output', this.sourceLines ? this.sourceLines[lineInformation.line] : null, this.sourcePath, lineInformation.line, lineInformation.column);
	}

	public continue(): Promise<void> {
		return new Promise(async (resolve, _) => {
			while (true) {
				const end = await this.step();
				if (end) {
					break;
				}
			}

			resolve();
		});
	}

	private sendEvent(event: string, ...args: any[]): void {
		setImmediate(() => {
			this.emit(event, ...args);
		});
	}
}