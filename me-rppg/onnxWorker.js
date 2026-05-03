// ════════════════════════════════════════════════════════════════════
// ME-rPPG ONNX Worker (v12.2 — absolute paths)
// Based on Health-HCI-Group/ME-rPPG-demo (Apache 2.0 License)
// FIX v12.2: 절대 경로 사용 (워커가 me-rppg/ 안에 있어도 정상 작동)
// ════════════════════════════════════════════════════════════════════

importScripts("https://fastly.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/ort.min.js");

let onnxSession;
let state = {};

let lastTimestamp = null;

ort.env.wasm.wasmPaths = "https://fastly.jsdelivr.net/npm/onnxruntime-web@1.18.0/dist/";

// ★ FIX: 절대 경로 사용 (이전: "me-rppg/model.onnx" 상대 경로 → 중복됨)
ort.InferenceSession.create("/me-rppg/model.onnx", {
    executionProviders: ["wasm"],
}).then((session) => {
    onnxSession = session;
    console.log("[ME-rPPG] Model Session created");
    self.postMessage({
        type: "ready",
        which: "model",
    });
}).catch(err => {
    console.error("[ME-rPPG] Model load failed:", err);
    self.postMessage({ type: "error", which: "model", error: err.message });
});

function shapeOf(array) {
    const shape = [];
    let current = array;
    while (Array.isArray(current)) {
        shape.push(current.length);
        current = current[0];
    }
    return shape;
}

// ★ FIX: 절대 경로 사용 (이전: "./me-rppg/state.json")
fetch("/me-rppg/state.json")
    .then((res) => {
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText} for ${res.url}`);
        }
        return res.json();
    })
    .then((data) => {
        for (const [key, value] of Object.entries(data)) {
            const shape = shapeOf(value);
            const array = new Float32Array(value.flat(Infinity));
            state[key] = new ort.Tensor("float32", array, shape);
        }
        console.log("[ME-rPPG] Initial state loaded");
        self.postMessage({type: "ready", which: "state"});
    })
    .catch(err => {
        console.error("[ME-rPPG] State load failed:", err);
        self.postMessage({ type: "error", which: "state", error: err.message });
    });

self.onmessage = async (event) => {
    if (!onnxSession || !state) {
        console.log("[ME-rPPG] Model session or state not ready");
        return;
    }
    const startTime = Date.now();
    const { input, timestamp, lambda } = event.data;
    const inputData = new ort.Tensor("float32", input, [1, 1, 36, 36, 3]);
    const dt = new ort.Tensor("float32", [Math.max((lastTimestamp ? (timestamp - lastTimestamp) / lambda : 1 / 30), 1/90)], []);
    lastTimestamp = timestamp;
    const feeds = {};
    feeds[onnxSession.inputNames[0]] = inputData;
    for (const [key, value] of Object.entries(state)) {
        feeds[key] = value;
    }
    feeds[onnxSession.inputNames[37]] = dt;
    const outputs = await onnxSession.run(feeds);
    const output = outputs[onnxSession.outputNames[0]]["cpuData"]["0"];
    for (let i = 1; i < onnxSession.outputNames.length; i++) {
        state[onnxSession.inputNames[i]] = outputs[onnxSession.outputNames[i]];
    }
    const nowTime = Date.now();
    const delay = nowTime - startTime;
    self.postMessage({output, delay, timestamp: nowTime, type: "data"});
};
