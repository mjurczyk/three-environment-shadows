import * as THREE from 'three';

// NOTE The same test scene as the main example, so results compare
export function createScene(scene) {
  const meshes = [];

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(6, 64),
    new THREE.MeshStandardMaterial({ color: 0xbbbbbb, roughness: 0.9 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  ground.name = 'ground';
  scene.add(ground);
  meshes.push(ground);

  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.2, metalness: 1 });

  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.8, 0.3, 128, 32), material);
  knot.position.set(0, 1.8, 0);
  knot.name = 'knot';
  scene.add(knot);
  meshes.push(knot);

  const box = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.4, 1.2), material);
  box.position.set(-2.5, 1.2, -1);
  box.rotation.y = 0.4;
  scene.add(box);
  meshes.push(box);

  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.7, 64, 32), metal);
  sphere.position.set(2.4, 0.7, 1.2);
  scene.add(sphere);
  meshes.push(sphere);

  for (let i = 0; i < 8; i++) {
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2, 16), material);
    const angle = (i / 8) * Math.PI * 2;
    pillar.position.set(Math.cos(angle) * 4.5, 1, Math.sin(angle) * 4.5);
    scene.add(pillar);
    meshes.push(pillar);
  }

  for (const mesh of meshes) {
    if (mesh !== ground) mesh.castShadow = true;
    mesh.receiveShadow = true;
  }

  return { meshes, knot, dynamicMeshes: [knot], materials: [ground.material, material, metal] };
}
