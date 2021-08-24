import { EventEmitter } from 'events';
import { Socket } from 'net';
import { Subject } from 'rxjs';
import { v4 } from 'uuid';

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
		this.clientSubject.subscribe(client => this.client = client);
	}

	sourcePath: string | undefined;
	sourceText: string | undefined;
	sourceLines: string[] | undefined;
	client: Socket | undefined;
	clientConnected = false;
	clientSubject = new Subject<Socket | undefined>();
	dataSubject = new Subject<any | undefined>();

	// eslint-disable-next-line @typescript-eslint/naming-convention
	__mockLine = 0;

	public start(path: string, stopAtEntry = false): Promise<ProgramStartResponse> {
		return new Promise(async (resolve, _) => {
			this.sourcePath = path;
			this.sourceText = await this.fileAccessor.readFile(this.sourcePath);
			this.sourceLines = this.sourceText?.split(/\r?\n/);

			if (!this.client) {
				this.startClient();
				const subscription = this.clientSubject.subscribe(async client => {
					const guid = v4();
					client?.write(JSON.stringify({
						debugCommand: stopAtEntry ? 'startStopEntry' : 'start',
						guid: guid
					}));

					const dataSubscription = this.dataSubject.subscribe(data => {
						if (data && data.guid === guid) {
							if (data.debugCommand === 'stopOnEntry') {
								this.sendEvent('stopOnEntry');
							}

							resolve({ hasError: false });
							dataSubscription.unsubscribe();
						}
					});

					subscription.unsubscribe();
				});
			} else {
				const guid = v4();
				this.client.write(JSON.stringify({
					debugCommand: stopAtEntry ? 'startStopEntry' : 'start',
					guid: guid
				}));

				const dataSubscription = this.dataSubject.subscribe(data => {
					if (data && data.guid === guid) {
						if (data.debugCommand === 'stopOnEntry') {
							this.sendEvent('stopOnEntry');
						}

						resolve({ hasError: false });
						dataSubscription.unsubscribe();
					}
				});
			}
			// resolve({ hasError: true, error: 'Could not compile source. Errors have been found.' });
		});
	}

	private startClient() {
		this.client = new Socket();
		this.client.connect(55821, '127.0.0.1', () => {
			this.client?.addListener('end', () => this.sendEvent('end'));
			this.client?.addListener('data', data => {
				const array = getJsonArray(data);
				if (array) {
					const objects = JSON.parse(array) || [];
					for (const object of objects) {
						this.dataSubject.next(object);
					}
				}
			});
			this.clientSubject.next(this.client);
		});
	}

	public clearBreakpoints(): Promise<void> {
		return new Promise((resolve, _) => {
			if (!this.client) {
				this.startClient();
				const subscription = this.clientSubject.subscribe(async client => {
					client?.write(JSON.stringify({
						debugCommand: 'clearBreakpoints'
					}));

					resolve();
					subscription.unsubscribe();
				});
			} else {
				this.client.write(JSON.stringify({
					debugCommand: 'clearBreakpoints'
				}));

				resolve();
			}
		});
	}

	public setBreakPoint(line: number): RuntimeBreakpoint | PromiseLike<RuntimeBreakpoint> {
		return new Promise((resolve, _) => {
			const guid = v4();

			this.client?.write(JSON.stringify({
				debugCommand: 'setBreakpoint',
				line,
				guid
			}));

			const subscription = this.dataSubject.subscribe(data => {
				if (data && data.guid === guid) {
					console.log(data);
					resolve(data);
					subscription.unsubscribe();
				}
			});
		});
	}

	public step(): Promise<boolean> {
		return new Promise(async (resolve, _) => {
			this.client?.write(JSON.stringify({
				debugCommand: 'step'
			}));

			const subscription = this.dataSubject.subscribe(data => {
				if (data && (data.debugCommand === 'stopOnStep' || data.debugCommand === 'end')) {
					console.log(data.debugCommand);
					this.sendEvent(data.debugCommand);
					resolve(data.debugCommand === 'end');
					subscription.unsubscribe();
				}
			});
		});
	}

	public getStackFrames(): Promise<RuntimeStackframes> {
		return new Promise(async (resolve, _) => {
			const guid = v4();
			this.client?.write(JSON.stringify({
				debugCommand: 'getStackFrames',
				guid
			}));

			const subscription = this.dataSubject.subscribe(data => {
				if (data && data.guid === guid) {
					const frames = (data.frames || []).map(item => ({ ...item, file: this.sourcePath || '' }));
					subscription.unsubscribe();
					resolve({ ...data, frames });
				}
			});
		});
	}

	// private getLineInformation(): Promise<{ line: number; column?: number }> {
	// 	return new Promise((resolve, _) => {
	// 		// query backend for line
	// 		resolve({ line: this.__mockLine });
	// 	});
	// }

	// private async printLine() {
	// 	const lineInformation = await this.getLineInformation();
	// 	this.sendEvent('output', this.sourceLines ? this.sourceLines[lineInformation.line] : null, this.sourcePath, lineInformation.line, lineInformation.column);
	// }

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

	public disconnect() {
		if (this.client) {
			this.client.end();
		}
	}

	private sendEvent(event: string, ...args: any[]): void {
		setImmediate(() => {
			this.emit(event, ...args);
		});
	}
}

function getJsonArray(buffer: Buffer): string | undefined {
	const list: string[] = [];
	const jsons = buffer.toString();
	let bracketValue = 0;
	let insideJson = false;
	let currentStart = 0;

	for (var i = 0; i < jsons.length; i++) {
		bracketValue += jsons[i] === '{' ? 1 : (jsons[i] === '}' ? -1 : 0);
		if (bracketValue > 0 && !insideJson) {
			currentStart = i;
			insideJson = true;
		}
		if (bracketValue === 0 && insideJson) {
			list.push(jsons.substring(currentStart, i + 1));
			insideJson = false;
		}
	}

	return list.length > 0
		? `[${list.join(',')}]`
		: undefined;
}