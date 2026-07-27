# loopycode-server

RSocket server for LoopyCode — runs the Agent/Subagent orchestration, connects to Ollama or OpenAI-compatible model providers, and serves the [`loopycode`](https://www.npmjs.com/package/loopycode) CLI client over RSocket.

## Install

```bash
npm install -g loopycode-server
```

## Usage

```bash
loopy-server start
```

Detect local hardware (GPU/CPU capabilities used for model recommendations):

```bash
loopy-detect-hardware
```

See the [project README](https://github.com/johnle1/LoopyCode#readme) for the full client/server architecture.

## License

ISC
