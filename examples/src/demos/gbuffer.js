import * as THREE from 'three';

/**
 * Screen G-buffer for screen-space techniques.
 * textures[0] = world position xyz, w = linear view depth (0 for sky)
 * textures[1] = world normal xyz (faces the camera), w = 1 (0 for sky)
 * depthTexture = hardware depth
 */
export class GBuffer {
  constructor(width = 1, height = 1) {
    this.target = new THREE.WebGLRenderTarget(width, height, {
      count: 2,
      type: THREE.FloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    });
    this.target.depthTexture = new THREE.DepthTexture(width, height, THREE.FloatType);

    this.material = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      side: THREE.DoubleSide,
      vertexShader: /* glsl */ `
        out vec3 vWorldPosition;
        out vec3 vWorldNormal;
        out float vDepth;

        void main() {
          vec4 world = modelMatrix * vec4( position, 1.0 );
          vWorldPosition = world.xyz;
          vWorldNormal = normalize( transpose( inverse( mat3( modelMatrix ) ) ) * normal );
          vec4 view = viewMatrix * world;
          vDepth = - view.z;
          gl_Position = projectionMatrix * view;
        }
      `,
      fragmentShader: /* glsl */ `
        in vec3 vWorldPosition;
        in vec3 vWorldNormal;
        in float vDepth;

        layout( location = 0 ) out vec4 gPosition;
        layout( location = 1 ) out vec4 gNormal;

        void main() {
          vec3 n = normalize( vWorldNormal );
          if ( ! gl_FrontFacing ) n = - n;
          gPosition = vec4( vWorldPosition, vDepth );
          gNormal = vec4( n, 1.0 );
        }
      `,
    });

    this.frame = -1;
    this._clearColor = new THREE.Color();
  }

  get position() {
    return this.target.textures[0];
  }

  get normal() {
    return this.target.textures[1];
  }

  get depth() {
    return this.target.depthTexture;
  }

  setSize(width, height) {
    this.target.setSize(width, height);
  }

  /** Renders the G-buffer once per frame, later calls in the same frame do nothing. */
  render(renderer, scene, camera, frame) {
    if (frame === this.frame) return;

    this.frame = frame;

    const background = scene.background;
    const override = scene.overrideMaterial;
    const target = renderer.getRenderTarget();
    const alpha = renderer.getClearAlpha();
    renderer.getClearColor(this._clearColor);

    // NOTE The G-buffer needs no shadow maps, the main render updates them
    const shadowAutoUpdate = renderer.shadowMap.autoUpdate;

    scene.background = null;
    scene.overrideMaterial = this.material;
    renderer.shadowMap.autoUpdate = false;
    renderer.setRenderTarget(this.target);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);

    renderer.shadowMap.autoUpdate = shadowAutoUpdate;
    scene.background = background;
    scene.overrideMaterial = override;
    renderer.setRenderTarget(target);
    renderer.setClearColor(this._clearColor, alpha);
  }

  dispose() {
    this.target.dispose();
    this.material.dispose();
  }
}
