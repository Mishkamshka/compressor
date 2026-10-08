// A small pool of compression workers so several images run at once
// without freezing the page.

export function createPool({ size, getSettings, onStart, onDone }) {
  const queue = [];
  const idle = [];
  let spawned = 0;
  let run = 0;

  function spawn() {
    const worker = new Worker(new URL('./compress.worker.js', import.meta.url), { type: 'module' });
    worker.job = null;
    worker.onmessage = ({ data }) => {
      const job = worker.job;
      worker.job = null;
      if (job && job.item.run === data.run) onDone(job.item, data);
      release(worker);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      const job = worker.job;
      worker.terminate();
      spawned -= 1;
      if (job && job.item.run === job.run) {
        onDone(job.item, {
          ok: false,
          error: 'The browser stopped this one, usually because the image is too large for memory.',
        });
      }
      pump();
    };
    spawned += 1;
    return worker;
  }

  function release(worker) {
    idle.push(worker);
    pump();
  }

  function pump() {
    while (queue.length) {
      let worker = idle.pop();
      if (!worker) {
        if (spawned >= size) return;
        worker = spawn();
      }
      const item = queue.shift();
      const settings = getSettings();
      const job = { item, run: ++run };
      item.run = job.run;
      item.key = settingsKey(settings);
      worker.job = job;
      onStart(item);
      worker.postMessage({ id: item.id, run: job.run, file: item.file, settings });
    }
  }

  return {
    add(item) {
      queue.push(item);
      pump();
    },
    // Drop a waiting item. One already being compressed finishes, but its result is ignored.
    cancel(item) {
      const i = queue.indexOf(item);
      if (i !== -1) queue.splice(i, 1);
      item.run = -1;
    },
    get busy() {
      return queue.length > 0 || spawned - idle.length > 0;
    },
  };
}

// Only the settings that change the compressed bytes. Renaming doesn't.
export function settingsKey(s) {
  return [s.format, s.mode, Number(s.maxWidth) || 0, s.longEdge ? 1 : 0].join('|');
}
