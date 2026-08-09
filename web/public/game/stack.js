/**
 * Stack — the block-dropping game, adapted to run inside Razzy.
 *
 * Original game logic is unchanged; what differs from the standalone version:
 *   · no window.focus() — it runs in an iframe and stealing focus scrolls the app
 *   · the orthographic resize actually works (it was missing left/right and
 *     updateProjectionMatrix, so rotating a phone squashed everything)
 *   · devicePixelRatio, or it renders soft on every phone made in the last decade
 *   · a Play again button, because "press R" is not available on a touchscreen
 */

let camera, scene, renderer
let world
let lastTime
let stack      // blocks that stayed
let overhangs  // the offcuts, falling
const boxHeight = 1
const originalBoxSize = 3
let autopilot
let gameEnded
let robotPrecision

const scoreEl = document.getElementById('score')
const instructionsEl = document.getElementById('instructions')
const resultsEl = document.getElementById('results')
const finalEl = document.getElementById('final')

init()

function setRobotPrecision() {
  robotPrecision = Math.random() * 1 - 0.5
}

function init() {
  autopilot = true
  gameEnded = false
  lastTime = 0
  stack = []
  overhangs = []
  setRobotPrecision()

  world = new CANNON.World()
  world.gravity.set(0, -10, 0)
  world.broadphase = new CANNON.NaiveBroadphase()
  world.solver.iterations = 40

  const aspect = window.innerWidth / window.innerHeight
  const width = 10
  const height = width / aspect

  camera = new THREE.OrthographicCamera(width / -2, width / 2, height / 2, height / -2, 0, 100)
  camera.position.set(4, 4, 4)
  camera.lookAt(0, 0, 0)

  scene = new THREE.Scene()

  addLayer(0, 0, originalBoxSize, originalBoxSize)
  addLayer(-10, 0, originalBoxSize, originalBoxSize, 'x')

  scene.add(new THREE.AmbientLight(0xffffff, 0.65))
  const dirLight = new THREE.DirectionalLight(0xffffff, 0.6)
  dirLight.position.set(10, 20, 0)
  scene.add(dirLight)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  // Without this every phone renders the game at CSS pixels and it looks soft.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.setAnimationLoop(animation)
  document.body.appendChild(renderer.domElement)
}

function startGame() {
  autopilot = false
  gameEnded = false
  lastTime = 0
  stack = []
  overhangs = []

  instructionsEl.classList.remove('show')
  resultsEl.classList.remove('show')
  scoreEl.innerText = 0

  while (world.bodies.length > 0) world.remove(world.bodies[0])
  while (scene.children.find((c) => c.type === 'Mesh')) {
    scene.remove(scene.children.find((c) => c.type === 'Mesh'))
  }

  addLayer(0, 0, originalBoxSize, originalBoxSize)
  addLayer(-10, 0, originalBoxSize, originalBoxSize, 'x')

  camera.position.set(4, 4, 4)
  camera.lookAt(0, 0, 0)
}

function addLayer(x, z, width, depth, direction) {
  const y = boxHeight * stack.length
  const layer = generateBox(x, y, z, width, depth, false)
  layer.direction = direction
  stack.push(layer)
}

function addOverhang(x, z, width, depth) {
  const y = boxHeight * (stack.length - 1)
  overhangs.push(generateBox(x, y, z, width, depth, true))
}

function generateBox(x, y, z, width, depth, falls) {
  const geometry = new THREE.BoxGeometry(width, boxHeight, depth)
  // Razzy green at the base, drifting through the spectrum as the tower grows.
  const color = new THREE.Color(`hsl(${142 + stack.length * 4}, 65%, 52%)`)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ color }))
  mesh.position.set(x, y, z)
  scene.add(mesh)

  const shape = new CANNON.Box(new CANNON.Vec3(width / 2, boxHeight / 2, depth / 2))
  let mass = falls ? 5 : 0
  mass *= width / originalBoxSize
  mass *= depth / originalBoxSize
  const body = new CANNON.Body({ mass, shape })
  body.position.set(x, y, z)
  world.addBody(body)

  return { threejs: mesh, cannonjs: body, width, depth }
}

function cutBox(topLayer, overlap, size, delta) {
  const direction = topLayer.direction
  const newWidth = direction === 'x' ? overlap : topLayer.width
  const newDepth = direction === 'z' ? overlap : topLayer.depth

  topLayer.width = newWidth
  topLayer.depth = newDepth

  topLayer.threejs.scale[direction] = overlap / size
  topLayer.threejs.position[direction] -= delta / 2
  topLayer.cannonjs.position[direction] -= delta / 2

  // Cannon shapes can't be scaled, only replaced.
  const shape = new CANNON.Box(new CANNON.Vec3(newWidth / 2, boxHeight / 2, newDepth / 2))
  topLayer.cannonjs.shapes = []
  topLayer.cannonjs.addShape(shape)
}

function eventHandler() {
  if (resultsEl.classList.contains('show')) return // the button handles restarting
  if (autopilot) startGame()
  else splitBlockAndAddNextOneIfOverlaps()
}

window.addEventListener('mousedown', eventHandler)
window.addEventListener('touchstart', (e) => { e.preventDefault(); eventHandler() }, { passive: false })
window.addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); eventHandler() }
  else if (e.key === 'r' || e.key === 'R') { e.preventDefault(); startGame() }
})
document.getElementById('start').addEventListener('click', (e) => { e.stopPropagation(); startGame() })
document.getElementById('again').addEventListener('click', (e) => { e.stopPropagation(); startGame() })

function splitBlockAndAddNextOneIfOverlaps() {
  if (gameEnded) return

  const topLayer = stack[stack.length - 1]
  const previousLayer = stack[stack.length - 2]
  const direction = topLayer.direction

  const size = direction === 'x' ? topLayer.width : topLayer.depth
  const delta = topLayer.threejs.position[direction] - previousLayer.threejs.position[direction]
  const overhangSize = Math.abs(delta)
  const overlap = size - overhangSize

  if (overlap <= 0) return missedTheSpot()

  cutBox(topLayer, overlap, size, delta)

  const overhangShift = (overlap / 2 + overhangSize / 2) * Math.sign(delta)
  const overhangX = direction === 'x' ? topLayer.threejs.position.x + overhangShift : topLayer.threejs.position.x
  const overhangZ = direction === 'z' ? topLayer.threejs.position.z + overhangShift : topLayer.threejs.position.z
  const overhangWidth = direction === 'x' ? overhangSize : topLayer.width
  const overhangDepth = direction === 'z' ? overhangSize : topLayer.depth
  addOverhang(overhangX, overhangZ, overhangWidth, overhangDepth)

  const nextX = direction === 'x' ? topLayer.threejs.position.x : -10
  const nextZ = direction === 'z' ? topLayer.threejs.position.z : -10
  const nextDirection = direction === 'x' ? 'z' : 'x'

  scoreEl.innerText = stack.length - 1
  addLayer(nextX, nextZ, topLayer.width, topLayer.depth, nextDirection)
}

function missedTheSpot() {
  const topLayer = stack[stack.length - 1]
  addOverhang(topLayer.threejs.position.x, topLayer.threejs.position.z, topLayer.width, topLayer.depth)
  world.remove(topLayer.cannonjs)
  scene.remove(topLayer.threejs)

  gameEnded = true
  if (!autopilot) {
    finalEl.innerText = Math.max(0, stack.length - 2)
    resultsEl.classList.add('show')
  }
}

function animation(time) {
  if (lastTime) {
    const timePassed = time - lastTime
    const speed = 0.008

    const topLayer = stack[stack.length - 1]
    const previousLayer = stack[stack.length - 2]

    const boxShouldMove =
      !gameEnded &&
      (!autopilot ||
        topLayer.threejs.position[topLayer.direction] <
          previousLayer.threejs.position[topLayer.direction] + robotPrecision)

    if (boxShouldMove) {
      topLayer.threejs.position[topLayer.direction] += speed * timePassed
      topLayer.cannonjs.position[topLayer.direction] += speed * timePassed
      if (topLayer.threejs.position[topLayer.direction] > 10) missedTheSpot()
    } else if (autopilot) {
      splitBlockAndAddNextOneIfOverlaps()
      setRobotPrecision()
    }

    if (camera.position.y < boxHeight * (stack.length - 2) + 4) {
      camera.position.y += speed * timePassed
    }

    updatePhysics(timePassed)
    renderer.render(scene, camera)
  }
  lastTime = time
}

function updatePhysics(timePassed) {
  world.step(timePassed / 1000)
  overhangs.forEach((el) => {
    el.threejs.position.copy(el.cannonjs.position)
    el.threejs.quaternion.copy(el.cannonjs.quaternion)
  })
}

/**
 * An orthographic camera needs its frustum rebuilt by hand. The original only
 * touched top/bottom and never called updateProjectionMatrix, so resizing — or
 * simply turning a phone sideways — did nothing at all and the scene came out
 * stretched.
 */
window.addEventListener('resize', () => {
  const aspect = window.innerWidth / window.innerHeight
  const width = 10
  const height = width / aspect

  camera.left = width / -2
  camera.right = width / 2
  camera.top = height / 2
  camera.bottom = height / -2
  camera.updateProjectionMatrix()

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(window.innerWidth, window.innerHeight)
  renderer.render(scene, camera)
})
