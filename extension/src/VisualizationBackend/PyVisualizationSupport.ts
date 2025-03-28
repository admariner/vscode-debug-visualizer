import {
	DataExtractionResult,
	DataExtractorId,
} from "@hediet/debug-visualizer-data-extraction";
import { hotClass, registerUpdateReconciler } from "@hediet/node-reload";
import { Config } from "../Config";
import { DebugSessionProxy } from "../proxies/DebugSessionProxy";
import { DebuggerViewProxy } from "../proxies/DebuggerViewProxy";
import { FormattedMessage } from "../webviewContract";
import {
	DebugSessionVisualizationSupport,
	GetVisualizationDataArgs,
	VisualizationBackend,
	VisualizationBackendBase,
} from "./VisualizationBackend";
import { parseEvaluationResultFromGenericDebugAdapter } from "./parseEvaluationResultFromGenericDebugAdapter";

registerUpdateReconciler(module);

@hotClass(module)
export class PyEvaluationEngine implements DebugSessionVisualizationSupport {
	constructor(
		private readonly debuggerView: DebuggerViewProxy,
		private readonly config: Config
	) {}

	createBackend(
		session: DebugSessionProxy
	): VisualizationBackend | undefined {
		const supportedDebugAdapters = ["python", "debugpy"];

		if (supportedDebugAdapters.indexOf(session.session.type) !== -1) {
			return new PyVisualizationBackend(
				session,
				this.debuggerView,
				this.config
			);
		}
		return undefined;
	}
}

export class PyVisualizationBackend extends VisualizationBackendBase {
	public readonly expressionLanguageId = "python";

	constructor(
		debugSession: DebugSessionProxy,
		debuggerView: DebuggerViewProxy,
		private readonly config: Config
	) {
		super(debugSession, debuggerView);
	}

	protected getContext(): "watch" | "repl" {
		// we will use "repl" as default so that results are not truncated.
		return "repl";
	}

	public async getVisualizationData({
		expression,
		preferredExtractorId,
	}: GetVisualizationDataArgs): Promise<
		| { kind: "data"; result: DataExtractionResult }
		| { kind: "error"; message: FormattedMessage }
	> {
		const frameId = this.debuggerView.getActiveStackFrameId(
			this.debugSession
		);

		const finalExpression = this.getFinalExpression({
			expression,
			preferredExtractorId,
		});
		let reply: { result: string; variablesReference: number };
		try {
			// inject vscodedebugvisualizer for python
			await this.debugSession.evaluate({
				expression:
					"from vscodedebugvisualizer import visualize\ntry:\n  import debugvisualizer\nexcept ImportError:\n  pass",
				frameId,
				context: this.getContext(),
			});

			reply = await this.debugSession.evaluate({
				expression: finalExpression,
				frameId,
				context: this.getContext(),
			});

			let result = reply.result;
			// remove the initial escape by the the debug session e.g. `''{"kind": {"text": true}, "text": "{"asdf1\'"}''`
			result = result.replace(/\\'/g, "'");
			result = result.replace(/\\\\/g, "\\");

			return parseEvaluationResultFromGenericDebugAdapter(result, {
				debugAdapterType: this.debugSession.session.configuration.type,
			});
		} catch (error) {
			let errorTyped = error as Error;
			if (
				errorTyped.message.includes(
					"ModuleNotFoundError: No module named 'vscodedebugvisualizer'"
				)
			) {
				return {
					kind: "error",
					message: {
						kind: "list",
						items: [
							"Please make sure vscodedebugvisualizer is installed: `pip install vscodedebugvisualizer`",
						],
					},
				};
			}
			return {
				kind: "error",
				message: {
					kind: "list",
					items: [
						"An error occurred while evaluating the expression:",
						errorTyped.message,
						`Used debug adapter: ${this.debugSession.session.configuration.type}`,
						{
							kind: "inlineList",
							items: [
								"Evaluated expression is",
								{ kind: "code", content: finalExpression },
							],
						},
					],
				},
			};
		}
	}

	protected getFinalExpression(args: {
		expression: string;
		preferredExtractorId: DataExtractorId | undefined;
	}): string {
		// wrap expression with visualize function
		let pythonInject = "";
		pythonInject += "visualize(" + args.expression + ")";
		return pythonInject;
	}
}
