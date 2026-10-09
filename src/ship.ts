import * as THREE from 'three';
import type { PerspectiveCamera } from 'three';
import type { SeaSample, SeaSimulation } from './sea.ts';

interface HullStation {
  z: number;
  halfBeam: number;
  bottomY: number;
  deckY: number;
}

const HULL_STATIONS: HullStation[] = [
  { z: -12, halfBeam: 0.06, bottomY: -0.42, deckY: -0.04 },
  { z: -10, halfBeam: 1.34, bottomY: -1.05, deckY: 0.42 },
  { z: -7, halfBeam: 2.44, bottomY: -1.55, deckY: 0.7 },
  { z: -3, halfBeam: 2.92, bottomY: -1.78, deckY: 0.82 },
  { z: 2, halfBeam: 3, bottomY: -1.8, deckY: 0.82 },
  { z: 7, halfBeam: 2.75, bottomY: -1.6, deckY: 0.84 },
  { z: 10, halfBeam: 2.22, bottomY: -1.35, deckY: 0.76 },
  { z: 12, halfBeam: 1.28, bottomY: -1.02, deckY: 0.58 },
];

const EYE_HEIGHT = 4.2;
const EYE_FORWARD = 5;
const ISOMETRIC_HEIGHT = 24;
const ISOMETRIC_AFT = 47;
const LOOK_YAW_LIMIT = (110 * Math.PI) / 180;
const LOOK_UP_LIMIT = (35 * Math.PI) / 180;
const LOOK_DOWN_LIMIT = (45 * Math.PI) / 180;

export class Ship {
  readonly root = new THREE.Group();
  worldX = 0;
  worldZ = 0;
  heading = 0;
  speed = 6;

  private readonly motion = new THREE.Group();
  private readonly viewMount = new THREE.Group();
  private readonly isometricMount = new THREE.Group();
  private readonly geometries: THREE.BufferGeometry[] = [];
  private readonly materials: THREE.Material[] = [];
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly hullSamples: [SeaSample, SeaSample, SeaSample, SeaSample] = [
    { height: 0, dx: 0, dz: 0 },
    { height: 0, dx: 0, dz: 0 },
    { height: 0, dx: 0, dz: 0 },
    { height: 0, dx: 0, dz: 0 },
  ];
  private readonly eyeSample: SeaSample = { height: 0, dx: 0, dz: 0 };
  private readonly eyeWorld = new THREE.Vector3();
  private readonly localUp = new THREE.Vector3(0, 1, 0);
  private readonly viewQuaternion = new THREE.Quaternion();
  private readonly railDirection = new THREE.Vector3();
  private readonly unitY = new THREE.Vector3(0, 1, 0);
  private smoothedHeave = 0;
  private smoothedPitch = 0;
  private smoothedRoll = 0;

  constructor() {
    this.root.add(this.motion, this.isometricMount);
    this.motion.add(this.viewMount);
    this.viewMount.position.set(0, EYE_HEIGHT, EYE_FORWARD);
    this.isometricMount.position.set(0, ISOMETRIC_HEIGHT, ISOMETRIC_AFT);

    const hullMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: '#252a34',
        roughness: 0.93,
        metalness: 0.02,
        side: THREE.DoubleSide,
      }),
    );
    const deckMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: '#171b24',
        roughness: 0.98,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
    );
    const railMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial({ color: '#96836b', roughness: 0.82, metalness: 0.08 }),
    );
    const cabinMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial({ color: '#645143', roughness: 0.94, metalness: 0.02 }),
    );
    const windowMaterial = this.trackMaterial(
      new THREE.MeshStandardMaterial({
        color: '#211d25',
        roughness: 0.88,
        metalness: 0,
        emissive: '#9d5f36',
        emissiveIntensity: 0.36,
      }),
    );
    const hullGeometry = this.trackGeometry(this.createHullGeometry());
    const deckGeometry = this.trackGeometry(this.createDeckGeometry());
    const hull = new THREE.Mesh(hullGeometry, hullMaterial);
    const deck = new THREE.Mesh(deckGeometry, deckMaterial);
    hull.castShadow = true;
    hull.receiveShadow = true;
    deck.castShadow = true;
    deck.receiveShadow = true;
    this.motion.add(hull, deck);

    const railGeometry = this.trackGeometry(new THREE.CylinderGeometry(0.035, 0.035, 1, 8));
    const postGeometry = this.trackGeometry(new THREE.CylinderGeometry(0.045, 0.045, 1, 8));
    const postPositions = [-5, -3, 0, 3, 6, 8];
    for (const side of [-1, 1]) {
      const x = side * 2.42;
      for (const z of postPositions) {
        const post = new THREE.Mesh(postGeometry, railMaterial);
        post.position.set(x, 1.43, z);
        post.scale.y = 1.06;
        post.castShadow = true;
        this.motion.add(post);
      }
      for (let index = 0; index < postPositions.length - 1; index += 1) {
        const startZ = postPositions[index];
        const endZ = postPositions[index + 1];
        for (const y of [1.16, 1.83]) {
          const rail = new THREE.Mesh(railGeometry, railMaterial);
          rail.position.set(x, y, (startZ + endZ) / 2);
          this.railDirection.set(0, 0, endZ - startZ).normalize();
          rail.quaternion.setFromUnitVectors(this.unitY, this.railDirection);
          rail.scale.y = endZ - startZ;
          rail.castShadow = true;
          this.motion.add(rail);
        }
      }
    }

    this.addBox(cabinMaterial, [2.7, 1.42, 2.4], [0, 1.56, 7.45]);
    this.addBox(cabinMaterial, [3.05, 0.18, 2.72], [0, 2.36, 7.45]);
    this.addBox(windowMaterial, [2.28, 0.65, 0.055], [0, 1.88, 6.22]);
    this.addBox(windowMaterial, [0.055, 0.68, 1.4], [-1.37, 1.88, 7.4]);
    this.addBox(windowMaterial, [0.055, 0.68, 1.4], [1.37, 1.88, 7.4]);
    this.addBox(deckMaterial, [1.5, 0.52, 1.1], [0, 1.23, 5.35]);

    const mastGeometry = this.trackGeometry(new THREE.CylinderGeometry(0.045, 0.065, 1, 8));
    const mast = new THREE.Mesh(mastGeometry, railMaterial);
    mast.position.set(0, 2.95, 8.25);
    mast.scale.y = 1.25;
    mast.castShadow = true;
    this.motion.add(mast);
    const radar = new THREE.Mesh(this.boxGeometry, railMaterial);
    radar.scale.set(0.42, 0.06, 0.08);
    radar.position.set(0, 3.6, 8.25);
    this.motion.add(radar);
    this.trackGeometry(this.boxGeometry);
  }

  advance(dt: number, throttle: number, rudder: number): void {
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const normalizedThrottle = Number.isFinite(throttle)
      ? Math.max(0, Math.min(1, throttle))
      : 0;
    const normalizedRudder = Number.isFinite(rudder) ? Math.max(-1, Math.min(1, rudder)) : 0;
    const targetSpeed = 10 * normalizedThrottle;
    this.speed += (targetSpeed - this.speed) * (1 - Math.exp(-step / 2));
    this.heading += normalizedRudder * 0.18 * (this.speed / 10) * step;
    this.worldX += Math.sin(this.heading) * this.speed * step;
    this.worldZ -= Math.cos(this.heading) * this.speed * step;
    this.root.rotation.y = -this.heading;
  }

  followSea(dt: number, sea: SeaSimulation): void {
    const forwardX = Math.sin(this.heading);
    const forwardZ = -Math.cos(this.heading);
    const starboardX = Math.cos(this.heading);
    const starboardZ = Math.sin(this.heading);
    const bow = this.hullSamples[0];
    const stern = this.hullSamples[1];
    const port = this.hullSamples[2];
    const starboard = this.hullSamples[3];
    sea.sample(forwardX * 10, forwardZ * 10, bow);
    sea.sample(-forwardX * 10, -forwardZ * 10, stern);
    sea.sample(-starboardX * 2.5, -starboardZ * 2.5, port);
    sea.sample(starboardX * 2.5, starboardZ * 2.5, starboard);

    const targetHeave = (bow.height + stern.height + port.height + starboard.height) / 4;
    const targetPitch = Math.max(-0.45, Math.min(0.45, (bow.height - stern.height) / 20));
    const targetRoll = Math.max(-0.35, Math.min(0.35, (starboard.height - port.height) / 5));
    const step = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    const blend = 1 - Math.exp(-step / 0.6);
    this.smoothedHeave += (targetHeave - this.smoothedHeave) * blend;
    this.smoothedPitch += (targetPitch - this.smoothedPitch) * blend;
    this.smoothedRoll += (targetRoll - this.smoothedRoll) * blend;
    this.motion.position.y = this.smoothedHeave;
    this.motion.rotation.set(this.smoothedPitch, 0, this.smoothedRoll);
  }

  applyView(
    camera: PerspectiveCamera,
    lookYaw: number,
    lookPitch: number,
    sea: SeaSimulation,
    isometric: boolean,
  ): void {
    const mount = isometric ? this.isometricMount : this.viewMount;
    if (camera.parent !== mount) mount.add(camera);
    camera.rotation.order = 'YXZ';
    if (isometric) {
      camera.rotation.set(-Math.atan2(ISOMETRIC_HEIGHT, ISOMETRIC_AFT), 0, 0);
    } else {
      const yaw = Math.max(-LOOK_YAW_LIMIT, Math.min(LOOK_YAW_LIMIT, lookYaw));
      const pitch = Math.max(-LOOK_DOWN_LIMIT, Math.min(LOOK_UP_LIMIT, lookPitch));
      camera.rotation.set(pitch, -yaw, 0);
    }
    camera.position.set(0, 0, 0);
    this.root.rotation.y = -this.heading;
    this.root.updateMatrixWorld(true);
    camera.getWorldPosition(this.eyeWorld);

    const sine = Math.sin(this.heading);
    const cosine = Math.cos(this.heading);
    const localX = this.eyeWorld.x * cosine + this.eyeWorld.z * sine;
    const localZ = -this.eyeWorld.x * sine + this.eyeWorld.z * cosine;
    sea.sample(localX, localZ, this.eyeSample);
    const clearance = this.eyeSample.height + 1.2 - this.eyeWorld.y;
    if (clearance > 0) {
      mount.getWorldQuaternion(this.viewQuaternion).invert();
      this.localUp.set(0, 1, 0).applyQuaternion(this.viewQuaternion);
      camera.position.addScaledVector(this.localUp, clearance);
      this.root.updateMatrixWorld(true);
    }
  }

  dispose(): void {
    for (const geometry of this.geometries) geometry.dispose();
    for (const material of this.materials) material.dispose();
    this.root.clear();
  }

  private createHullGeometry(): THREE.BufferGeometry {
    const profileCount = 6;
    const positions = new Float32Array(HULL_STATIONS.length * profileCount * 3);
    const indices: number[] = [];
    for (let stationIndex = 0; stationIndex < HULL_STATIONS.length; stationIndex += 1) {
      const station = HULL_STATIONS[stationIndex];
      const base = stationIndex * profileCount;
      const bottomHalf = station.halfBeam * 0.52;
      const coordinates = [
        [-bottomHalf, station.bottomY],
        [bottomHalf, station.bottomY],
        [station.halfBeam, station.bottomY + 0.22],
        [station.halfBeam * 0.93, station.deckY],
        [-station.halfBeam * 0.93, station.deckY],
        [-station.halfBeam, station.bottomY + 0.22],
      ];
      for (let profileIndex = 0; profileIndex < profileCount; profileIndex += 1) {
        const vertex = base + profileIndex;
        positions[vertex * 3] = coordinates[profileIndex][0];
        positions[vertex * 3 + 1] = coordinates[profileIndex][1];
        positions[vertex * 3 + 2] = station.z;
      }
    }

    for (let stationIndex = 0; stationIndex < HULL_STATIONS.length - 1; stationIndex += 1) {
      const current = stationIndex * profileCount;
      const next = (stationIndex + 1) * profileCount;
      for (let profileIndex = 0; profileIndex < profileCount; profileIndex += 1) {
        const nextProfile = (profileIndex + 1) % profileCount;
        const a = current + profileIndex;
        const b = current + nextProfile;
        const c = next + nextProfile;
        const d = next + profileIndex;
        indices.push(a, b, c, a, c, d);
      }
    }

    const bowCenter = positions.length / 3;
    const sternCenter = bowCenter + 1;
    const bowStation = HULL_STATIONS[0];
    const sternStation = HULL_STATIONS[HULL_STATIONS.length - 1];
    const extendedPositions = new Float32Array(positions.length + 6);
    extendedPositions.set(positions);
    extendedPositions[bowCenter * 3 + 1] = (bowStation.bottomY + bowStation.deckY) / 2;
    extendedPositions[bowCenter * 3 + 2] = bowStation.z;
    extendedPositions[sternCenter * 3 + 1] = (sternStation.bottomY + sternStation.deckY) / 2;
    extendedPositions[sternCenter * 3 + 2] = sternStation.z;
    for (let profileIndex = 0; profileIndex < profileCount; profileIndex += 1) {
      const nextProfile = (profileIndex + 1) % profileCount;
      indices.push(bowCenter, nextProfile, profileIndex);
      const sternBase = (HULL_STATIONS.length - 1) * profileCount;
      indices.push(sternCenter, sternBase + profileIndex, sternBase + nextProfile);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(extendedPositions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  private createDeckGeometry(): THREE.BufferGeometry {
    const positions = new Float32Array(HULL_STATIONS.length * 2 * 3);
    const indices: number[] = [];
    for (let stationIndex = 0; stationIndex < HULL_STATIONS.length; stationIndex += 1) {
      const station = HULL_STATIONS[stationIndex];
      const halfWidth = station.halfBeam * 0.89;
      const left = stationIndex * 2;
      positions[left * 3] = -halfWidth;
      positions[left * 3 + 1] = station.deckY + 0.025;
      positions[left * 3 + 2] = station.z;
      positions[(left + 1) * 3] = halfWidth;
      positions[(left + 1) * 3 + 1] = station.deckY + 0.025;
      positions[(left + 1) * 3 + 2] = station.z;
    }
    for (let stationIndex = 0; stationIndex < HULL_STATIONS.length - 1; stationIndex += 1) {
      const current = stationIndex * 2;
      const next = current + 2;
      indices.push(current, current + 1, next + 1, current, next + 1, next);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    return geometry;
  }

  private addBox(
    material: THREE.Material,
    size: [number, number, number],
    position: [number, number, number],
  ): void {
    const box = new THREE.Mesh(this.boxGeometry, material);
    box.scale.set(size[0], size[1], size[2]);
    box.position.set(position[0], position[1], position[2]);
    box.castShadow = true;
    box.receiveShadow = true;
    this.motion.add(box);
  }

  private trackGeometry<T extends THREE.BufferGeometry>(geometry: T): T {
    this.geometries.push(geometry);
    return geometry;
  }

  private trackMaterial<T extends THREE.Material>(material: T): T {
    this.materials.push(material);
    return material;
  }
}
