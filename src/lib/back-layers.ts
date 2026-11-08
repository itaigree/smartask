/**
 * Android's back gesture (and the browser's back button) walks the browser's
 * history. The app is one page, so with nothing in that history, back leaves
 * the site — or closes the installed app — even while a sheet or a settings
 * screen is open, and whatever was typed there is lost.
 *
 * So each open overlay (a "layer") adds one history entry, and going back
 * closes the top layer instead of leaving. A layer closed any other way (its
 * own button, Escape) takes its entry back out, so the history never collects
 * dead entries that would need extra presses of back to get out.
 */

/** The part of `window.history` used here; a fake in tests. */
export interface HistoryLike {
  readonly state: unknown;
  pushState(data: unknown, unused: string): void;
  back(): void;
}

export interface BackLayers {
  /**
   * An overlay has opened; `close` closes it. Returns the function to call
   * once it has closed, however that happened.
   */
  open(close: () => void): () => void;
  /** The browser went back (a `popstate` event). */
  popped(): void;
}

export function createBackLayers(history: HistoryLike): BackLayers {
  type Layer = { close: () => void; done: boolean; pushed: boolean };
  const layers: Layer[] = [];
  /** Back steps this module took itself, whose popstate must not close anything. */
  let ownBacks = 0;

  const push = (layer: Layer) => {
    layer.pushed = true;
    // The URL stays as it is: the entry exists only to be stepped back over.
    history.pushState({ smartaskLayer: true }, '');
  };

  return {
    open(close) {
      const layer: Layer = { close, done: false, pushed: false };
      layers.push(layer);
      // The browser fixes where a back() lands when it is called, so an entry
      // added while one of ours is still on its way would be stepped over
      // too. Wait for it to land. (React's development mode closes and
      // reopens every overlay at once, so this is not just a fast finger.)
      if (ownBacks === 0) push(layer);
      return () => {
        if (layer.done) return; // back already removed its entry
        layer.done = true;
        layers.splice(layers.indexOf(layer), 1);
        if (!layer.pushed) return; // it never had one
        ownBacks += 1;
        history.back();
      };
    },
    popped() {
      if (ownBacks > 0) {
        ownBacks -= 1;
        if (ownBacks === 0) layers.filter((l) => !l.pushed).forEach(push);
        return;
      }
      const layer = layers.pop();
      if (!layer) return;
      // Its entry is already gone: closing must not step back a second time.
      layer.done = true;
      layer.close();
    },
  };
}

let shared: BackLayers | null = null;

/** The one set of layers for this page, listening to the real history. */
export function browserBackLayers(): BackLayers {
  if (!shared) {
    const layers = createBackLayers(window.history);
    window.addEventListener('popstate', () => layers.popped());
    shared = layers;
  }
  return shared;
}
