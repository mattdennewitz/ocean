export interface SeaSample {
  height: number;
  dx: number;
  dz: number;
}

const WAVE_COUNT = 8;
const ROGUE_COUNT = 3;
const TAU = Math.PI * 2;
const GRAVITY = 9.81;
const ROGUE_LIFETIME = 28;
const ROGUE_SPEED = 18;

const WAVE_SPECS = [
  [110, 1.5, 20],
  [68, 1.1, -15],
  [43, 0.75, 48],
  [27, 0.5, -42],
  [16, 0.28, 75],
  [9, 0.18, -70],
  [5, 0.1, 12],
  [3, 0.06, 115],
] as const;

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function rogueEnvelope(age: number): number {
  return smoothstep(0, 1.5, age) * (1 - smoothstep(22, 28, age));
}

export class SeaSimulation {
  readonly waveParameters = new Float32Array(WAVE_COUNT * 4);
  readonly phases = new Float32Array(WAVE_COUNT);
  readonly rogueParameters = new Float32Array(ROGUE_COUNT * 8);

  private readonly angularFrequencies = new Float64Array(WAVE_COUNT);
  private readonly initialPhases = new Float64Array(WAVE_COUNT);
  private readonly rogueAges = new Float64Array(ROGUE_COUNT);
  private readonly rogueWorldX = new Float64Array(ROGUE_COUNT);
  private readonly rogueWorldZ = new Float64Array(ROGUE_COUNT);
  private readonly rogueDirX = new Float64Array(ROGUE_COUNT);
  private readonly rogueDirZ = new Float64Array(ROGUE_COUNT);
  private readonly rogueActive = new Uint8Array(ROGUE_COUNT);

  private seaTime = 0;
  private currentIntensity = 0.7;
  private targetIntensity = 0.7;
  private shipWorldX = 0;
  private shipWorldZ = 0;
  private rogueCount = 0;

  constructor() {
    const amplitudeScale = this.amplitudeScale(this.currentIntensity);
    for (let index = 0; index < WAVE_COUNT; index += 1) {
      const [wavelength, amplitude, directionDegrees] = WAVE_SPECS[index];
      const angle = (directionDegrees * Math.PI) / 180;
      const k = TAU / wavelength;
      const offset = index * 4;
      this.waveParameters[offset] = Math.sin(angle);
      this.waveParameters[offset + 1] = -Math.cos(angle);
      this.waveParameters[offset + 2] = k;
      this.waveParameters[offset + 3] = amplitude * amplitudeScale;
      this.angularFrequencies[index] = Math.sqrt(GRAVITY * k);
      this.initialPhases[index] = index * 1.7;
      this.phases[index] = this.initialPhases[index];
    }
  }

  get elapsed(): number {
    return this.seaTime;
  }

  get intensity(): number {
    return this.currentIntensity;
  }

  get activeRogues(): number {
    return this.rogueCount;
  }

  setIntensity(percent: number): void {
    if (!Number.isFinite(percent)) return;
    this.targetIntensity = Math.max(0, Math.min(100, percent)) / 100;
  }

  update(dt: number, worldX: number, worldZ: number): void {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    this.seaTime += step;
    this.shipWorldX = worldX;
    this.shipWorldZ = worldZ;

    const blend = 1 - Math.exp(-step / 0.8);
    this.currentIntensity += (this.targetIntensity - this.currentIntensity) * blend;
    const amplitudeScale = this.amplitudeScale(this.currentIntensity);

    for (let index = 0; index < WAVE_COUNT; index += 1) {
      const offset = index * 4;
      const directionX = this.waveParameters[offset];
      const directionZ = this.waveParameters[offset + 1];
      const k = this.waveParameters[offset + 2];
      const baseAmplitude = WAVE_SPECS[index][1];
      this.waveParameters[offset + 3] = baseAmplitude * amplitudeScale;

      let phase =
        k * (directionX * worldX + directionZ * worldZ) -
        this.angularFrequencies[index] * this.seaTime +
        this.initialPhases[index];
      phase %= TAU;
      if (phase < 0) phase += TAU;
      this.phases[index] = phase;
    }

    for (let index = 0; index < ROGUE_COUNT; index += 1) {
      const parameterOffset = index * 8;
      if (this.rogueActive[index] === 0) {
        this.clearRogueParameters(parameterOffset);
        continue;
      }

      const age = this.rogueAges[index] + step;
      if (age >= ROGUE_LIFETIME) {
        this.rogueActive[index] = 0;
        this.rogueCount -= 1;
        this.clearRogueParameters(parameterOffset);
        continue;
      }

      this.rogueAges[index] = age;
      this.rogueWorldX[index] += this.rogueDirX[index] * ROGUE_SPEED * step;
      this.rogueWorldZ[index] += this.rogueDirZ[index] * ROGUE_SPEED * step;
      this.writeRogueParameters(index, parameterOffset);
    }
  }

  sample(localX: number, localZ: number, out: SeaSample): void {
    let height = 0;
    let dx = 0;
    let dz = 0;

    for (let index = 0; index < WAVE_COUNT; index += 1) {
      const offset = index * 4;
      const directionX = this.waveParameters[offset];
      const directionZ = this.waveParameters[offset + 1];
      const k = this.waveParameters[offset + 2];
      const amplitude = this.waveParameters[offset + 3];
      const phase =
        k * (directionX * localX + directionZ * localZ) + this.phases[index];
      const sinPhase = Math.sin(phase);
      const sinDoublePhase = Math.sin(2 * phase);
      const derivative = amplitude * k * (Math.cos(phase) + 0.4 * Math.cos(2 * phase));
      height += amplitude * (sinPhase + 0.2 * sinDoublePhase);
      dx += derivative * directionX;
      dz += derivative * directionZ;
    }

    for (let index = 0; index < ROGUE_COUNT; index += 1) {
      const offset = index * 8;
      const strength = this.rogueParameters[offset + 4];
      if (strength === 0) continue;

      const relativeX = localX - this.rogueParameters[offset];
      const relativeZ = localZ - this.rogueParameters[offset + 1];
      const directionX = this.rogueParameters[offset + 2];
      const directionZ = this.rogueParameters[offset + 3];
      const acrossX = -directionZ;
      const acrossZ = directionX;
      const along = relativeX * directionX + relativeZ * directionZ;
      const across = relativeX * acrossX + relativeZ * acrossZ;
      const crossEnvelope = Math.exp(-(across * across) / (2 * 120 * 120));
      const leading = Math.exp(-(along * along) / (2 * 18 * 18));
      const trailing = Math.exp(-((along + 42) * (along + 42)) / (2 * 24 * 24));
      const longitudinal = leading - 0.45 * trailing;
      const alongDerivative =
        (-along / (18 * 18)) * leading +
        (0.45 * (along + 42) / (24 * 24)) * trailing;
      const acrossDerivative = (-across / (120 * 120)) * crossEnvelope * longitudinal;
      const heightScale = strength * crossEnvelope;

      height += heightScale * longitudinal;
      const derivativeAlong = heightScale * alongDerivative;
      const derivativeAcross = strength * acrossDerivative;
      dx += derivativeAlong * directionX + derivativeAcross * acrossX;
      dz += derivativeAlong * directionZ + derivativeAcross * acrossZ;
    }

    out.height = height;
    out.dx = dx;
    out.dz = dz;
  }

  launchRogue(worldX: number, worldZ: number, heading: number): boolean {
    for (let index = 0; index < ROGUE_COUNT; index += 1) {
      if (this.rogueActive[index] !== 0) continue;

      const forwardX = Math.sin(heading);
      const forwardZ = -Math.cos(heading);
      this.rogueActive[index] = 1;
      this.rogueAges[index] = 0;
      this.rogueWorldX[index] = worldX + forwardX * 180;
      this.rogueWorldZ[index] = worldZ + forwardZ * 180;
      this.rogueDirX[index] = -forwardX;
      this.rogueDirZ[index] = -forwardZ;
      this.rogueCount += 1;
      this.writeRogueParameters(index, index * 8);
      return true;
    }
    return false;
  }

  private amplitudeScale(intensity: number): number {
    return 0.06 + 1.54 * intensity * intensity;
  }

  private writeRogueParameters(index: number, offset: number): void {
    this.rogueParameters[offset] = this.rogueWorldX[index] - this.shipWorldX;
    this.rogueParameters[offset + 1] = this.rogueWorldZ[index] - this.shipWorldZ;
    this.rogueParameters[offset + 2] = this.rogueDirX[index];
    this.rogueParameters[offset + 3] = this.rogueDirZ[index];
    this.rogueParameters[offset + 4] = 12 * rogueEnvelope(this.rogueAges[index]);
    this.rogueParameters[offset + 5] = 0;
    this.rogueParameters[offset + 6] = 0;
    this.rogueParameters[offset + 7] = 0;
  }

  private clearRogueParameters(offset: number): void {
    for (let component = 0; component < 8; component += 1) {
      this.rogueParameters[offset + component] = 0;
    }
  }
}
