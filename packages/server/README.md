# atlasagents-server

RSocket server for AtlasAgents — runs the Agent/Subagent orchestration, connects to Ollama or OpenAI-compatible model providers, and serves the [`atlasagents`](https://www.npmjs.com/package/atlasagents) CLI client over RSocket.

## Install

```bash
npm install -g atlasagents-server
```

## Usage

```bash
atlas-server start
```

Detect local hardware (GPU/CPU capabilities used for model recommendations):

```bash
atlas-detect-hardware
```

See the [project README](https://github.com/johnle1/LoopyCode#readme) for the full client/server architecture.

## License

Apache-2.0
