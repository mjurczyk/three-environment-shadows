// NOTE Measures GPU time per frame with EXT_disjoint_timer_query_webgl2, null when not supported
export class GpuTimer {
  constructor(gl) {
    this.gl = gl;
    this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.pending = [];
    this.active = null;
    this.ms = null;
  }

  begin() {
    if (!this.ext || this.active) return;

    this.active = this.gl.createQuery();
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, this.active);
  }

  end() {
    if (!this.ext || !this.active) return;

    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
    this.poll();
  }

  poll() {
    const { gl, ext } = this;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);

    while (this.pending.length > 0) {
      const query = this.pending[0];

      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;

      this.pending.shift();

      if (!disjoint) {
        const ms = gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6;
        this.ms = this.ms === null ? ms : this.ms * 0.9 + ms * 0.1;
      }

      gl.deleteQuery(query);
    }
  }
}
