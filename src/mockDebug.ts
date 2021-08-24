/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/


import { DebugProtocol } from 'vscode-debugprotocol';
// import { basename } from 'path';
import { FileAccessor, RuntimeAdapter, RuntimeBreakpoint } from './mockRuntime';
import { Subject } from 'await-notify';
import { LoggingDebugSession, StoppedEvent, InitializedEvent, logger, Logger, Breakpoint, BreakpointEvent, Scope, Thread, OutputEvent, Source, TerminatedEvent, StackFrame, Handles } from 'vscode-debugadapter';
import { basename } from 'path';

/**
 * This interface describes the mock-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the mock-debug extension.
 * The interface should always match this schema.
 */
interface ILaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
	/** enable logging the Debug Adapter Protocol */
	trace?: boolean;
	/** run without debugging */
	noDebug?: boolean;
	/** if specified, results in a simulated compile error in launch. */
	compileError?: 'default' | 'show' | 'hide';
}

export class MockDebugSession extends LoggingDebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static threadID = 1;

	// a Mock runtime (or debugger)
	private runtimeAdapter: RuntimeAdapter;
	private configurationDone = new Subject();
	private handles = new Handles<'locals' | 'globals' | any>();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor(fileAccessor: FileAccessor) {
		super("mock-debug.txt");

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this.runtimeAdapter = new RuntimeAdapter(fileAccessor);

		// setup event handlers
		this.setupEvents();
	}

	/** Setup event handlers */
	protected setupEvents() {
		this.runtimeAdapter.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', MockDebugSession.threadID));
		});
		this.runtimeAdapter.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', MockDebugSession.threadID));
		});
		this.runtimeAdapter.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', MockDebugSession.threadID));
		});
		this.runtimeAdapter.on('stopOnException', (exception) => {
			if (exception) {
				this.sendEvent(new StoppedEvent(`exception(${exception})`, MockDebugSession.threadID));
			} else {
				this.sendEvent(new StoppedEvent('exception', MockDebugSession.threadID));
			}
		});
		this.runtimeAdapter.on('breakpointValidated', (breakpoint: RuntimeBreakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', { verified: breakpoint.verified, id: breakpoint.id } as DebugProtocol.Breakpoint));
		});
		this.runtimeAdapter.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);

			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);

			this.sendEvent(e);
		});
		this.runtimeAdapter.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		// build and return the capabilities of this debug adapter:
		this.setCapabilities(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	private setCapabilities(response: DebugProtocol.InitializeResponse) {
		response.body = response.body || {};
		// the adapter implements the configurationDone request.
		response.body.supportsConfigurationDoneRequest = true;
		// make VS Code send cancel request
		response.body.supportsCancelRequest = true;
		// make VS Code send the breakpointLocations request
		response.body.supportsBreakpointLocationsRequest = true;

		this.sendResponse(response);
	}

	/**
	 * Called at the end of the configuration sequence.
	 * Indicates that all breakpoints etc. have been sent to the DA and that the 'launch' can start.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this.configurationDone.notify();
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: ILaunchRequestArguments) {

		// make sure to 'Stop' the buffered logging if 'trace' is not set
		logger.setup(args.trace ? Logger.LogLevel.Verbose : Logger.LogLevel.Stop, false);

		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this.configurationDone.wait(1000);

		// start the program in the runtime
		const startResponse = await this.runtimeAdapter.start(args.program, !!args.stopOnEntry);

		if (startResponse.hasError) {
			// simulate a compile/build error in "launch" request:
			// the error should not result in a modal dialog since 'showUser' is set to false.
			// A missing 'showUser' should result in a modal dialog.
			this.sendErrorResponse(response, {
				id: 1001,
				format: `Runtime error: ${startResponse.error}`,
				showUser: true
			});
		} else {
			this.sendResponse(response);
		}
	}

	protected disconnectRequest(response: DebugProtocol.DisconnectResponse, args: DebugProtocol.DisconnectArguments, request?: DebugProtocol.Request): void {
		this.runtimeAdapter.disconnect();
		this.sendResponse(response);
	}

	protected async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): Promise<void> {
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		await this.runtimeAdapter.clearBreakpoints();

		// set and verify breakpoint locations
		const trueBreakpoints = clientLines.map(async l => {
			const { verified, line, id } = await this.runtimeAdapter.setBreakPoint(this.convertClientLineToDebugger(l));
			const breakpoint = new Breakpoint(verified, this.convertDebuggerLineToClient(line)) as DebugProtocol.Breakpoint;
			return { ...breakpoint, id };
		});

		const breakpoints = await Promise.all<DebugProtocol.Breakpoint>(trueBreakpoints);

		// send back the actual breakpoint positions
		this.sendResponse({ ...response, body: { ...response.body, breakpoints } });
	}

	protected async breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): Promise<void> {
		const breakpoints = await this.runtimeAdapter.getBreakpoints(); // array

		response.body = {
			// breakpoints: breakpoints.map(item => ({ ...item, line: this.convertDebuggerLineToClient(item.line) }))
			breakpoints
		};

		this.sendResponse(response);
	}

	// protected async setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): Promise<void> {

	// 	let namedException: string | undefined = undefined;
	// 	let otherExceptions = false;

	// 	if (args.filterOptions) {
	// 		for (const filterOption of args.filterOptions) {
	// 			switch (filterOption.filterId) {
	// 				case 'namedException':
	// 					namedException = args.filterOptions[0].condition;
	// 					break;
	// 				case 'otherExceptions':
	// 					otherExceptions = true;
	// 					break;
	// 			}
	// 		}
	// 	}

	// 	if (args.filters) {
	// 		if (args.filters.indexOf('otherExceptions') >= 0) {
	// 			otherExceptions = true;
	// 		}
	// 	}

	// 	this._runtime.setExceptionsFilters(namedException, otherExceptions);

	// 	this.sendResponse(response);
	// }

	// protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments) {
	// 	response.body = {
	// 		exceptionId: 'Exception ID',
	// 		description: 'This is a descriptive description of the exception.',
	// 		breakMode: 'always',
	// 		details: {
	// 			message: 'Message contained in the exception.',
	// 			typeName: 'Short type name of the exception object',
	// 			stackTrace: 'stack frame 1\nstack frame 2',
	// 		}
	// 	};
	// 	this.sendResponse(response);
	// }

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {

		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(MockDebugSession.threadID, "Thread 1")
			]
		};
		this.sendResponse(response);
	}

	protected async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): Promise<void> {

		const stackFrames = await this.runtimeAdapter.getStackFrames();

		response.body = {
			stackFrames: stackFrames.frames.map(frame =>
				new StackFrame(frame.index, frame.name,
					this.createSource(frame.file), this.convertDebuggerLineToClient(frame.line))),
			totalFrames: stackFrames.count
		};
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {

		response.body = {
			scopes: [
				new Scope("Globals", this.handles.create('globals'), true)
			]
		};
		this.sendResponse(response);
	}

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request): Promise<void> {
		const variables = await this.runtimeAdapter.getVariables();

		response.body = {
			variables: variables.map(v => this.convertFromRuntime(v))
		};
		this.sendResponse(response);
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		// const scope = this.handles.get(args.variablesReference);
		// if (scope === 'locals') {
		// 	const rv = this._runtime.getLocalVariable(args.name);
		// 	if (rv) {
		// 		rv.value = this.convertToRuntime(args.value);
		// 		response.body = this.convertFromRuntime(rv);
		// 	}
		// }
		this.sendResponse(response);
	}

	protected async continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): Promise<void> {
		await this.runtimeAdapter.continue();
		this.sendResponse(response);
	}

	protected async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): Promise<void> {
		await this.runtimeAdapter.step();
		this.sendResponse(response);
	}

	// protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
	// 	this._runtime.step(args.granularity === 'instruction', true);
	// 	this.sendResponse(response);
	// }

	// protected stepInTargetsRequest(response: DebugProtocol.StepInTargetsResponse, args: DebugProtocol.StepInTargetsArguments) {
	// 	const targets = this._runtime.getStepInTargets(args.frameId);
	// 	response.body = {
	// 		targets: targets.map(t => {
	// 			return { id: t.id, label: t.label };
	// 		})
	// 	};
	// 	this.sendResponse(response);
	// }

	// protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
	// 	this._runtime.stepIn(args.targetId);
	// 	this.sendResponse(response);
	// }

	// protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
	// 	this._runtime.stepOut();
	// 	this.sendResponse(response);
	// }

	// protected async evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): Promise<void> {

	// 	let reply: string | undefined;
	// 	let rv: IRuntimeVariable | undefined;

	// 	switch (args.context) {
	// 		case 'repl':
	// 			// handle some REPL commands:
	// 			// 'evaluate' supports to create and delete breakpoints from the 'repl':
	// 			const matches = /new +([0-9]+)/.exec(args.expression);
	// 			if (matches && matches.length === 2) {
	// 				const mbp = await this._runtime.setBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
	// 				const bp = new Breakpoint(mbp.verified, this.convertDebuggerLineToClient(mbp.line), undefined, this.createSource(this._runtime.sourceFile)) as DebugProtocol.Breakpoint;
	// 				bp.id= mbp.id;
	// 				this.sendEvent(new BreakpointEvent('new', bp));
	// 				reply = `breakpoint created`;
	// 			} else {
	// 				const matches = /del +([0-9]+)/.exec(args.expression);
	// 				if (matches && matches.length === 2) {
	// 					const mbp = this._runtime.clearBreakPoint(this._runtime.sourceFile, this.convertClientLineToDebugger(parseInt(matches[1])));
	// 					if (mbp) {
	// 						const bp = new Breakpoint(false) as DebugProtocol.Breakpoint;
	// 						bp.id= mbp.id;
	// 						this.sendEvent(new BreakpointEvent('removed', bp));
	// 						reply = `breakpoint deleted`;
	// 					}
	// 				} else {
	// 					const matches = /progress/.exec(args.expression);
	// 					if (matches && matches.length === 1) {
	// 						if (this._reportProgress) {
	// 							reply = `progress started`;
	// 							this.progressSequence();
	// 						} else {
	// 							reply = `frontend doesn't support progress (capability 'supportsProgressReporting' not set)`;
	// 						}
	// 					}
	// 				}
	// 			}
	// 			// fall through

	// 		default:
	// 			if (args.expression.startsWith('$')) {
	// 				rv = this._runtime.getLocalVariable(args.expression.substr(1));
	// 			} else {
	// 				rv = {
	// 					name: 'eval',
	// 					value: this.convertToRuntime(args.expression)
	// 				};
	// 			}
	// 			break;
	// 	}

	// 	if (rv) {
	// 		const v = this.convertFromRuntime(rv);
	// 		response.body = {
	// 			result: v.value,
	// 			type: v.type,
	// 			variablesReference: v.variablesReference
	// 		};
	// 	} else {
	// 		response.body = {
	// 			result: reply ? reply : `evaluate(context: '${args.context}', '${args.expression}')`,
	// 			variablesReference: 0
	// 		};
	// 	}

	// 	this.sendResponse(response);
	// }

	// protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {

	// 	if (args.expression.startsWith('$')) {
	// 		const rv = this._runtime.getLocalVariable(args.expression.substr(1));
	// 		if (rv) {
	// 			rv.value = this.convertToRuntime(args.value);
	// 			response.body = this.convertFromRuntime(rv);
	// 			this.sendResponse(response);
	// 		} else {
	// 			this.sendErrorResponse(response, {
	// 				id: 1002,
	// 				format: `variable '{lexpr}' not found`,
	// 				variables: { lexpr: args.expression },
	// 				showUser: true
	// 			});	
	// 		}
	// 	} else {
	// 		this.sendErrorResponse(response, {
	// 			id: 1003,
	// 			format: `'{lexpr}' not an assignable expression`,
	// 			variables: { lexpr: args.expression },
	// 			showUser: true
	// 		});
	// 	}
	// }

	// private async progressSequence() {

	// 	const ID = '' + this._progressId++;

	// 	await timeout(100);

	// 	const title = this._isProgressCancellable ? 'Cancellable operation' : 'Long running operation';
	// 	const startEvent: DebugProtocol.ProgressStartEvent = new ProgressStartEvent(ID, title);
	// 	startEvent.body.cancellable = this._isProgressCancellable;
	// 	this._isProgressCancellable = !this._isProgressCancellable;
	// 	this.sendEvent(startEvent);
	// 	this.sendEvent(new OutputEvent(`start progress: ${ID}\n`));

	// 	let endMessage = 'progress ended';

	// 	for (let i = 0; i < 100; i++) {
	// 		await timeout(500);
	// 		this.sendEvent(new ProgressUpdateEvent(ID, `progress: ${i}`));
	// 		if (this._cancelledProgressId === ID) {
	// 			endMessage = 'progress cancelled';
	// 			this._cancelledProgressId = undefined;
	// 			this.sendEvent(new OutputEvent(`cancel progress: ${ID}\n`));
	// 			break;
	// 		}
	// 	}
	// 	this.sendEvent(new ProgressEndEvent(ID, endMessage));
	// 	this.sendEvent(new OutputEvent(`end progress: ${ID}\n`));

	// 	this._cancelledProgressId = undefined;
	// }

	// protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {

	// 	response.body = {
	//         dataId: null,
	//         description: "cannot break on data access",
	//         accessTypes: undefined,
	//         canPersist: false
	//     };

	// 	if (args.variablesReference && args.name) {
	// 		const v = this._variableHandles.get(args.variablesReference);
	// 		if (v === 'globals') {
	// 			response.body.dataId = args.name;
	// 			response.body.description = args.name;
	// 			response.body.accessTypes = [ "write" ];
	// 			response.body.canPersist = true;
	// 		} else {
	// 			response.body.dataId = args.name;
	// 			response.body.description = args.name;
	// 			response.body.accessTypes = ["read", "write", "readWrite"];
	// 			response.body.canPersist = true;
	// 		}
	// 	}

	// 	this.sendResponse(response);
	// }

	// protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

	// 	// clear all data breakpoints
	// 	this._runtime.clearAllDataBreakpoints();

	// 	response.body = {
	// 		breakpoints: []
	// 	};

	// 	for (const dbp of args.breakpoints) {
	// 		const ok = this._runtime.setDataBreakpoint(dbp.dataId, dbp.accessType || 'write');
	// 		response.body.breakpoints.push({
	// 			verified: ok
	// 		});
	// 	}

	// 	this.sendResponse(response);
	// }

	// protected completionsRequest(response: DebugProtocol.CompletionsResponse, args: DebugProtocol.CompletionsArguments): void {

	// 	response.body = {
	// 		targets: [
	// 			{
	// 				label: "item 10",
	// 				sortText: "10"
	// 			},
	// 			{
	// 				label: "item 1",
	// 				sortText: "01"
	// 			},
	// 			{
	// 				label: "item 2",
	// 				sortText: "02"
	// 			},
	// 			{
	// 				label: "array[]",
	// 				selectionStart: 6,
	// 				sortText: "03"
	// 			},
	// 			{
	// 				label: "func(arg)",
	// 				selectionStart: 5,
	// 				selectionLength: 3,
	// 				sortText: "04"
	// 			}
	// 		]
	// 	};
	// 	this.sendResponse(response);
	// }

	// protected cancelRequest(response: DebugProtocol.CancelResponse, args: DebugProtocol.CancelArguments) {
	// 	if (args.requestId) {
	// 		this._cancellationTokens.set(args.requestId, true);
	// 	}
	// 	if (args.progressId) {
	// 		this._cancelledProgressId= args.progressId;
	// 	}
	// }

	// protected disassembleRequest(response: DebugProtocol.DisassembleResponse, args: DebugProtocol.DisassembleArguments) {

	// 	const baseAddress = parseInt(args.memoryReference);
	// 	const offset = args.instructionOffset || 0;
	// 	const count = args.instructionCount;

	// 	const isHex = args.memoryReference.startsWith('0x');
	// 	const pad = isHex ? args.memoryReference.length-2 : args.memoryReference.length;

	// 	const instructions = this._runtime.disassemble(baseAddress+offset, count).map(instruction => {
	// 		const address = instruction.address.toString(isHex ? 16 : 10).padStart(pad, '0');
	// 		return {
	// 			address: isHex ? `0x${address}` : `${address}`,
	// 			instruction: instruction.instruction
	// 		};
	// 	});

	// 	response.body = {
	// 		instructions: instructions
	// 	};
	// 	this.sendResponse(response);
	// }

	// protected setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments) {

	// 	// clear all instruction breakpoints
	// 	this._runtime.clearInstructionBreakpoints();

	// 	// set instruction breakpoints
	// 	const breakpoints = args.breakpoints.map(ibp => {
	// 		const address = parseInt(ibp.instructionReference);
	// 		const offset = ibp.offset || 0;
	// 		return <DebugProtocol.Breakpoint>{
	// 			verified: this._runtime.setInstructionBreakpoint(address + offset)
	// 		};
	// 	});

	// 	response.body = {
	// 		breakpoints: breakpoints
	// 	};
	// 	this.sendResponse(response);
	// }

	// protected customRequest(command: string, response: DebugProtocol.Response, args: any) {
	// 	if (command === 'toggleFormatting') {
	// 		this._valuesInHex = ! this._valuesInHex;
	// 		if (this._useInvalidatedEvent) {
	// 			this.sendEvent(new InvalidatedEvent( ['variables'] ));
	// 		}
	// 		this.sendResponse(response);
	// 	} else {
	// 		super.customRequest(command, response, args);
	// 	}
	// }

	// //---- helpers

	// private convertToRuntime(value: string): IRuntimeVariableType {

	// 	value= value.trim();

	// 	if (value === 'true') {
	// 		return true;
	// 	}
	// 	if (value === 'false') {
	// 		return false;
	// 	}
	// 	if (value[0] === '\'' || value[0] === '"') {
	// 		return value.substr(1, value.length-2);
	// 	}
	// 	const n = parseFloat(value);
	// 	if (!isNaN(n)) {
	// 		return n;
	// 	}
	// 	return value;
	// }

	private convertFromRuntime(v: any): DebugProtocol.Variable {

		let dapVariable: DebugProtocol.Variable = {
			name: v.name,
			value: this.formatNumber(v.value),
			type: 'integer',
			variablesReference: 0,
			evaluateName: '$' + v.name
		};

		(<any>dapVariable).__vscodeVariableMenuContext = 'simple';	// enable context menu contribution

		return dapVariable;
	}

	// private formatAddress(x: number, pad = 8) {
	// 	return this._addressesInHex ? '0x' + x.toString(16).padStart(8, '0') : x.toString(10);
	// }

	private formatNumber(number: number): string {
		// return '0x' + x.toString(16);
		return `${number}`;
	}

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, 'mock-adapter-data');
	}
}

