import {
  Color,
  DataTexture,
  DirectionalLight,
  Group,
  Object3D,
  Object3DEventMap,
  Scene,
  Sphere,
  Texture,
  Vector3,
} from 'three';

/**
 * One part of an extracted light.
 */
export interface LightPart {
  /** Unit vector from the scene towards the part, in the space of the environment map. */
  direction: Vector3;
  /** The color, normalized so its largest component is `1`. */
  color: Color;
  /** The irradiance, usable as `DirectionalLight.intensity`. */
  intensity: number;
  /** Half-angle (in radians) of the cone the part emits from. */
  coneAngle: number;
}

/**
 * A light source that was found in an environment map.
 */
export interface ExtractedLight extends LightPart {
  /** Fraction of the total environment energy emitted by this light. */
  energyFraction: number;
  /**
   * `partitions[ n - 1 ]` divides the light into `n` parts (median cut). The energies of the
   * parts add up to the energy of the light. `partitions[ 0 ]` holds the light as one part.
   */
  partitions: LightPart[][];
}

export interface ExtractionResult {
  /** The extracted lights, strongest first. */
  lights: ExtractedLight[];
  /** `0` if the environment emits equally in all directions, `1` if all light comes from one direction. */
  directionality: number;
  /** Fraction of the total environment energy emitted by the extracted lights. */
  dominance: number;
  /** The radiance (luminance) above which texels are part of a light. */
  threshold: number;
  /** A copy of the environment map without the extracted lights, or `null`. */
  texture: DataTexture | null;
}

export interface ExtractOptions {
  /** The maximum number of lights. Default `2`. */
  maxLights?: number;
  /** Texels brighter than this factor times the mean radiance are part of a light. Default `8`. */
  threshold?: number;
  /** The minimum fraction of the total energy a light must emit. Default `0.05`. */
  minEnergy?: number;
  /** The minimum elevation (in radians) of a light, in the space of the environment map. Default `-Math.PI / 2`. */
  minElevation?: number;
  /** The maximum number of parts per light, see `ExtractedLight.partitions`. Default `4`. */
  samples?: number;
  /** The width of the grid used to group bright texels into regions. Default `512`. */
  resolution?: number;
  /** Whether to create a copy of the environment map without the lights. Default `true`. */
  removeLights?: boolean;
}

/**
 * Finds the dominant light sources of an equirectangular environment map.
 */
export class EnvironmentLightExtractor {
  static extract(texture: Texture, options?: ExtractOptions): Promise<ExtractionResult>;
}

export interface EnvironmentShadowLightsOptions {
  /** The maximum number of lights. Default `2`. */
  maxLights?: number;
  /** Texels brighter than this factor times the mean radiance are part of a light. Default `8`. */
  threshold?: number;
  /** The minimum fraction of the total energy a light must emit. Default `0.05`. */
  minEnergy?: number;
  /** The minimum elevation (in radians) of a light, in the space of the environment map. Default `-Math.PI / 2`. */
  minElevation?: number;
  /** The width of the grid used to group bright texels into regions. Default `512`. */
  resolution?: number;
  /** The maximum number of shadow casting lights per light source. Default `4`. */
  samples?: number;
  /** The maximum number of shadow maps of all light sources. Default `4`. */
  maxShadowMaps?: number;
  /** The shadow map size of each light. Default `1024`. */
  mapSize?: number;
  /** The typical distance between shadow casters and receivers, relative to the bounds radius. Default `0.1`. */
  relativeOccluderDistance?: number;
}

export interface EnvironmentShadowLightsEventMap extends Object3DEventMap {
  /** The light sources changed, see `EnvironmentShadowLights.result`. */
  change: {};
}

/**
 * Casts shadows from the light sources of `scene.environment`.
 */
export class EnvironmentShadowLights extends Group<EnvironmentShadowLightsEventMap> {
  /** Constructs the group and adds it to the scene. */
  constructor(scene?: Scene | null, options?: EnvironmentShadowLightsOptions);

  readonly isEnvironmentShadowLights: true;

  maxLights: number;
  threshold: number;
  minEnergy: number;
  minElevation: number;
  resolution: number;
  samples: number;
  maxShadowMaps: number;
  mapSize: number;
  relativeOccluderDistance: number;

  /** Set to `true` to find the light sources again, e.g. after a change of the options. */
  needsUpdate: boolean;

  /** The area that receives shadows, in world space. */
  bounds: Sphere;

  /** The light sources of the environment map, or `null` before they are found. */
  readonly result: Omit<ExtractionResult, 'texture'> | null;

  /** The target of all lights, at the center of the bounds. */
  readonly target: Object3D;

  /** The lights. The shadow casting lights come first. */
  readonly lights: DirectionalLight[];

  /** Puts the original environment map back, frees the GPU-related resources and removes the group. */
  dispose(): void;
}
