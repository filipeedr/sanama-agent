import DOMMatrixPolyfill from '@thednp/dommatrix';

if (typeof globalThis.DOMMatrix === 'undefined') {
  // @ts-expect-error DOMMatrix não existe no ambiente Node, então polyfill com implementação em JS
  globalThis.DOMMatrix = DOMMatrixPolyfill as unknown as typeof DOMMatrix;
}
