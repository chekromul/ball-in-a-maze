import {
  Engine,
  Render,
  Runner,
  Bodies,
  Body,
  Composite,
  Events,
} from "matter-js";

export const config = {
  MAZE: {
    rings: 5, // number of concentric rings (including outermost)
  },
  WALL: {
    thickness: 0.027, // wall thickness as fraction of canvas size (0-1)
    fill: "#b8794f", // CSS color used to draw maze walls
    restitution: 0.18, // bounciness when ball hits wall
    friction: 0.7, // kinetic friction (wall-ball sliding)
    frictionStatic: 0.9, // static friction threshold
  },
  BALL: {
    radius: 0.027, // ball radius as fraction of canvas size (0-1)
    fill: "#dcdcdc", // ball base color (CSS)
    friction: 0.06, // kinetic friction between ball and walls
    frictionStatic: 0.3, // static friction threshold
    frictionAir: 0.006, // air damping (simulates heavier feel)
    restitution: 0.25, // bounciness (0 = no bounce, 1 = perfect)
    density: 0.01, // mass density used by physics engine
  },
  TILT: {
    maxDeg: 20, // maximum visual tilt (degrees) applied to the board
    deadzoneDeg: 1, // degrees within which small tilts are ignored
    gStrength: 3.0, // gravity multiplier applied when tilting
    releaseSmoothing: 0.18, // interpolation factor when releasing the drag
    visualScale: 0.12, // pointer movement → degrees conversion factor
    maxSpeed: 32, // maximum linear speed the ball may reach
    velocityDamping: 0.965, // velocity reduction per frame when not dragging (friction simulation)
  },
  TRANSITION: {
    duration: 250, // milliseconds for release/return animations
  },
};

export default function initMaze() {
  // ===========================
  // Helpers
  // ===========================

  const TAU = Math.PI * 2; // Full circle in radians
  const deg = (d) => (d * Math.PI) / 180; // Convert degrees to radians
  const rotationOffset = Math.random() * TAU; // Randomize the entire board orientation each load

  // ===========================
  // Constants
  // ===========================

  const container = document.querySelector(".maze");
  const W = Math.floor(container.getBoundingClientRect().width);
  const H = W;
  const cx = W / 2; // center X
  const cy = H / 2; // center Y
  const wallThickness = config.WALL.thickness * W;
  const ballRadius = config.BALL.radius * W;
  const outerRadius = Math.min(W, H) / 2 - wallThickness / 2; // distance from center to outermost ring
  const centerRadius = outerRadius / config.MAZE.rings; // radius of goal zone
  const gapWidth = ballRadius * 2 + ballRadius * 0.5;
  const gapPositionAngles = [deg(90), deg(270), deg(180), deg(0)];

  // ===========================
  // States
  // ===========================

  let isDragging = false;
  let pointerOrigin = null;
  let gravityTarget = { x: 0, y: 0 }; // gravity direction user is tilting toward
  let gravityCurrent = { x: 0, y: 0 }; // current gravity (smoothly interpolates to target)
  let wallShadowOffset = { x: 0, y: 0 };
  let isPreviouslyInCenter = false;

  // ===========================
  // Geometry and physics helpers
  // ===========================

  /**
   * Builds a curved wall arc by approximating it with many small static rectangles.
   *
   * @param {number} radius - Distance from center (cx, cy) to the arc
   * @param {number} angleStart - Starting angle in radians
   * @param {number} angleEnd - Ending angle in radians
   * @param {string} [fill=config.WALL.fill] - fill color
   */
  function arcWall(radius, angleStart, angleEnd, fill = config.WALL.fill) {
    // Adjust angles to apply random rotation offset (ensures different maze each load)
    const startAngle = angleStart + rotationOffset;
    const endAngle = angleEnd + rotationOffset;

    // Calculate the total angular span of the arc
    // If `endAngle` wrapped around, add `TAU` to ensure span is positive
    const angularSpan =
      endAngle < startAngle
        ? endAngle + TAU - startAngle
        : endAngle - startAngle;

    // Calculate adaptive segment density based on radius
    // Larger radius = higher density for smooth curves
    // Target: ~1 segment per 8-10 pixels of arc length for visual smoothness
    const arcLength = radius * angularSpan;
    const segmentCount = Math.max(24, Math.ceil(arcLength / 8));

    const invSegmentCount = 1 / segmentCount;
    const anglePerSegment = angularSpan / segmentCount; // How many radians each segment covers

    const bodies = [];

    // Build rectangular segments along the arc
    for (let i = 0; i < segmentCount; i++) {
      // Normalized position within arc: t0=start of segment, t1=end of segment (range 0 to 1)
      const t0 = i * invSegmentCount;
      const t1 = (i + 1) * invSegmentCount;

      // Angle at the midpoint of this segment (for better positioning)
      const angleAtMidpoint = startAngle + (t0 + t1) * 0.5 * angularSpan;
      const cosAngle = Math.cos(angleAtMidpoint);
      const sinAngle = Math.sin(angleAtMidpoint);

      // Position at the arc: (cx, cy) as center + radius in angle direction
      const posX = cx + radius * cosAngle;
      const posY = cy + radius * sinAngle;

      // Segment length: arc length of this small slice
      const segmentLength = Math.max(0.5, radius * anglePerSegment);

      // Create rectangle body rotated perpendicular to the arc
      bodies.push(
        Bodies.rectangle(posX, posY, segmentLength, wallThickness, {
          isStatic: true,
          angle: angleAtMidpoint + Math.PI / 2, // Rotate 90° so the long axis is tangent to the arc
          restitution: config.WALL.restitution,
          friction: config.WALL.friction,
          frictionStatic: config.WALL.frictionStatic,
          render: { fillStyle: fill },
        })
      );
    }

    Composite.add(engine.world, bodies);
  }

  /**
   * Converts pointer-derived tilt angles to physics gravity.
   * Applies deadzone threshold and scales by strength multiplier.
   *
   * @param {number} tiltXDeg - tilt angle around X axis (degrees)
   * @param {number} tiltYDeg - tilt angle around Y axis (degrees)
   * @returns {{ x: number, y: number }} gravity vector
   */
  function convertTiltToGravity(tiltXDeg, tiltYDeg) {
    // Apply deadzone: small tilts below threshold map to zero
    const rx = Math.abs(tiltXDeg) < config.TILT.deadzoneDeg ? 0 : tiltXDeg;
    const ry = Math.abs(tiltYDeg) < config.TILT.deadzoneDeg ? 0 : tiltYDeg;

    // Convert degrees to radians and compute gravity via sine (linear response)
    const gravityX = Math.sin((ry * Math.PI) / 180);
    const gravityY = -Math.sin((rx * Math.PI) / 180);

    // Apply configured strength multiplier
    return {
      x: config.TILT.gStrength * gravityX,
      y: config.TILT.gStrength * gravityY,
    };
  }

  // Clamp utility to constrain values within min/max range
  function clampValue(value, minValue, maxValue) {
    return Math.max(minValue, Math.min(maxValue, value));
  }

  // ===========================
  // Engine & renderer setup
  // ===========================

  const engine = Engine.create();
  engine.gravity.scale = 0.001;
  engine.gravity.x = 0;
  engine.gravity.y = 0;

  const render = Render.create({
    element: container,
    engine,
    options: {
      width: W,
      height: H,
      wireframes: false,
      background: "url('/wood.avif')",
    },
  });

  Render.run(render);
  Runner.run(Runner.create(), engine);

  container.style.setProperty(
    "--maze-transition-duration",
    `${config.TRANSITION.duration}ms`
  );

  // ===========================
  // Maze builder with rings & gaps
  // ===========================

  // Build each concentric ring
  for (let ringIndex = 0; ringIndex < config.MAZE.rings; ringIndex++) {
    const ringRadius =
      outerRadius - (ringIndex * outerRadius) / config.MAZE.rings;

    // Convert gap width to radians for this radius
    const gapAngleInRadians = gapWidth / ringRadius;

    // Outer ring (`ringIndex=0`) has no gap - full 360° circle
    if (ringIndex === 0) {
      arcWall(ringRadius, 0, TAU);
    }
    // Inner rings have one gap, cycling through positions
    else {
      const gapPositionIndex = (ringIndex - 1) % 4;
      const gapCenterAngle = gapPositionAngles[gapPositionIndex];
      const arcStartAngle = gapCenterAngle + gapAngleInRadians / 2;
      const arcEndAngle = gapCenterAngle + deg(360) - gapAngleInRadians / 2;

      arcWall(ringRadius, arcStartAngle, arcEndAngle);
    }
  }

  // ===========================
  // Ball creation
  // ===========================

  const spawnAngleRadians = deg(90);
  const spawnDistanceFromCenter = outerRadius - wallThickness;
  const spawnX = cx + spawnDistanceFromCenter * Math.cos(spawnAngleRadians);
  const spawnY = cy + spawnDistanceFromCenter * Math.sin(spawnAngleRadians);

  const ball = Bodies.circle(spawnX, spawnY, ballRadius, {
    friction: config.BALL.friction,
    frictionStatic: config.BALL.frictionStatic,
    frictionAir: config.BALL.frictionAir,
    restitution: config.BALL.restitution,
    density: config.BALL.density,
  });

  Composite.add(engine.world, ball);

  // ===========================
  // Physics update loop
  // ===========================
  Events.on(engine, "beforeUpdate", () => {
    if (isDragging) {
      gravityCurrent.x = gravityTarget.x;
      gravityCurrent.y = gravityTarget.y;
    } else {
      gravityCurrent.x +=
        (gravityTarget.x - gravityCurrent.x) * config.TILT.releaseSmoothing;
      gravityCurrent.y +=
        (gravityTarget.y - gravityCurrent.y) * config.TILT.releaseSmoothing;
    }

    engine.gravity.x = gravityCurrent.x;
    engine.gravity.y = gravityCurrent.y;

    // Apply velocity damping when not being controlled by user
    if (!isDragging) {
      Body.setVelocity(ball, {
        x: ball.velocity.x * config.TILT.velocityDamping,
        y: ball.velocity.y * config.TILT.velocityDamping,
      });
    }

    // Cap maximum ball speed to prevent runaway velocity
    const ballSpeed = Math.hypot(ball.velocity.x, ball.velocity.y);
    if (ballSpeed > config.TILT.maxSpeed) {
      // Normalize velocity to unit vector and scale to max speed
      Body.setVelocity(ball, {
        x: (ball.velocity.x / ballSpeed) * config.TILT.maxSpeed,
        y: (ball.velocity.y / ballSpeed) * config.TILT.maxSpeed,
      });
    }

    // Detect ball entry into goal zone
    const ballDistanceFromCenter = Math.hypot(
      ball.position.x - cx,
      ball.position.y - cy
    );
    const isCurrentlyInCenter = ballDistanceFromCenter < centerRadius;

    if (isCurrentlyInCenter && !isPreviouslyInCenter) {
      render.canvas.classList.add("win");
      render.canvas.addEventListener(
        "animationend",
        () => render.canvas.classList.remove("win"),
        { once: true }
      );
    }

    isPreviouslyInCenter = isCurrentlyInCenter;
  });

  // ===========================
  // Render wall shadows & 3D ball
  // ===========================
  Events.on(render, "afterRender", () => {
    const canvasContext = render.context;
    const allPhysicsBodies = Composite.allBodies(engine.world);

    // Step 1: Draw wall shadows (offset based on tilt angle)
    const isShadowVisible =
      wallShadowOffset.x !== 0 || wallShadowOffset.y !== 0;

    if (isShadowVisible) {
      canvasContext.save();
      canvasContext.fillStyle = config.WALL.fill;
      canvasContext.globalAlpha = 0.75;

      allPhysicsBodies.forEach((physicsBody) => {
        // Skip non-wall bodies
        if (!(physicsBody.isStatic && !physicsBody.circleRadius)) return;

        const wallVertices = physicsBody.vertices;
        if (!wallVertices || wallVertices.length === 0) return;

        // Draw polygon shadow by offsetting each vertex
        canvasContext.beginPath();
        canvasContext.moveTo(
          wallVertices[0].x + wallShadowOffset.x,
          wallVertices[0].y + wallShadowOffset.y
        );

        for (let i = 1; i < wallVertices.length; i++) {
          canvasContext.lineTo(
            wallVertices[i].x + wallShadowOffset.x,
            wallVertices[i].y + wallShadowOffset.y
          );
        }

        canvasContext.closePath();
        canvasContext.fill();
      });

      canvasContext.restore();
    }

    // Prepare ball rendering coordinates and dimensions
    canvasContext.save();

    const ballCenterX = ball.position.x;
    const ballCenterY = ball.position.y;
    const ballRadius = config.BALL.radius * W;

    // Draw flat drop shadow beneath the ball
    {
      canvasContext.save();
      canvasContext.globalCompositeOperation = "destination-over"; // draw behind existing content

      const ballShadowOffsetX = wallShadowOffset.x * 0.75;
      const ballShadowOffsetY = wallShadowOffset.y * 0.75;
      const ballShadowCenterX = ballCenterX + ballShadowOffsetX;
      const ballShadowCenterY = ballCenterY + ballShadowOffsetY;

      canvasContext.fillStyle = "rgb(0 0 0 / 25%)";
      canvasContext.beginPath();
      canvasContext.ellipse(
        ballShadowCenterX,
        ballShadowCenterY,
        ballRadius, // horizontal radius
        ballRadius, // vertical radius
        0, // rotation
        0, // start angle
        TAU // end angle (full circle)
      );
      canvasContext.fill();
      canvasContext.restore();
    }

    // Create 3D sphere effect using radial gradient with highlight
    const highlightOffsetFactor = 0.3; // position of bright spot (0.3 = top-left)
    const highlightRadiusFactor = 0.1; // size of bright spot (smaller = tighter highlight)

    const sphereGradient = canvasContext.createRadialGradient(
      ballCenterX - ballRadius * highlightOffsetFactor, // highlight X offset
      ballCenterY - ballRadius * highlightOffsetFactor, // highlight Y offset
      ballRadius * highlightRadiusFactor, // inner radius (bright core)
      ballCenterX, // gradient center X
      ballCenterY, // gradient center Y
      ballRadius // outer radius
    );

    // Define gradient color stops for 3D effect
    const ballBaseColor = config.BALL.fill;
    const ballHighlightColor = "rgb(255 255 255 / 60%)"; // bright reflection
    const ballShadowColor = `color-mix(in srgb, ${ballBaseColor} 60%, black)`; // darkened edge

    sphereGradient.addColorStop(0, ballHighlightColor); // center: bright highlight
    sphereGradient.addColorStop(0.3, ballBaseColor); // mid: base color
    sphereGradient.addColorStop(1, ballShadowColor); // edge: shadow for depth

    // Render the ball with gradient fill
    canvasContext.fillStyle = sphereGradient;
    canvasContext.beginPath();
    canvasContext.arc(ballCenterX, ballCenterY, ballRadius, 0, TAU);
    canvasContext.fill();

    canvasContext.restore();
  });

  // ===========================
  // Pointer Event Handlers
  // ===========================

  render.canvas.addEventListener("pointerdown", (pointerDownEvent) => {
    isDragging = true;
    pointerOrigin = {
      x: pointerDownEvent.clientX,
      y: pointerDownEvent.clientY,
    };

    document.body.classList.add("is-dragging");
    render.canvas.classList.add("is-dragging");
  });

  addEventListener("pointermove", (pointerMoveEvent) => {
    if (!isDragging) return;

    // Calculate pointer displacement from origin
    const pointerDeltaX = pointerMoveEvent.clientX - pointerOrigin.x;
    const pointerDeltaY = pointerMoveEvent.clientY - pointerOrigin.y;

    // Calculate tilt angles
    const tiltAngleXDeg = clampValue(
      -pointerDeltaY * config.TILT.visualScale,
      -config.TILT.maxDeg,
      config.TILT.maxDeg
    );
    const tiltAngleYDeg = clampValue(
      pointerDeltaX * config.TILT.visualScale,
      -config.TILT.maxDeg,
      config.TILT.maxDeg
    );

    // Convert tilt angles to physics gravity and set as target
    gravityTarget = convertTiltToGravity(tiltAngleXDeg, tiltAngleYDeg);

    // Update visual tilt CSS custom properties
    container.style.setProperty("--maze-tilt-x", `${tiltAngleXDeg}deg`);
    container.style.setProperty("--maze-tilt-y", `${tiltAngleYDeg}deg`);

    // Calculate shadow offset (perpendicular to tilt for 3D depth effect)
    // Shadow moves opposite to tilt direction to simulate light source
    const visualShadowOffsetX = -tiltAngleYDeg;
    const visualShadowOffsetY = tiltAngleXDeg;

    // Update CSS shadow properties for DOM rendering
    container.style.setProperty("--maze-shadow-x", `${visualShadowOffsetX}px`);
    container.style.setProperty("--maze-shadow-y", `${visualShadowOffsetY}px`);
    container.style.setProperty(
      "--maze-shadow-color",
      `color-mix(in srgb, ${config.WALL.fill} 75%, black)`
    );

    // Update canvas shadow offset
    const canvasShadowScale = 0.5;
    wallShadowOffset.x = visualShadowOffsetX * canvasShadowScale;
    wallShadowOffset.y = visualShadowOffsetY * canvasShadowScale;
  });

  /**
   * Release drag
   */
  addEventListener("pointerup", () => {
    isDragging = false;
    gravityTarget = { x: 0, y: 0 };

    document.body.classList.remove("is-dragging");
    render.canvas.classList.remove("is-dragging");

    container.style.setProperty("--maze-tilt-x", "0deg");
    container.style.setProperty("--maze-tilt-y", "0deg");
    container.style.setProperty("--maze-shadow-x", "0px");
    container.style.setProperty("--maze-shadow-y", "0px");

    // Animate canvas wall shadows back to zero with ease-out curve
    // Capture current shadow offset as animation start point
    const shadowAnimationStartOffset = { ...wallShadowOffset };
    const shadowAnimationStartTime = performance.now();
    const shadowAnimationDuration = config.TRANSITION.duration;

    // Recursive animation frame handler with quadratic ease-out
    const animateShadowReturn = (currentFrameTime) => {
      const elapsedTime = currentFrameTime - shadowAnimationStartTime;
      const linearProgress = Math.min(elapsedTime / shadowAnimationDuration, 1);
      const easedProgress = linearProgress * (2 - linearProgress);

      wallShadowOffset.x = shadowAnimationStartOffset.x * (1 - easedProgress);
      wallShadowOffset.y = shadowAnimationStartOffset.y * (1 - easedProgress);

      if (linearProgress < 1) {
        requestAnimationFrame(animateShadowReturn);
      } else {
        wallShadowOffset.x = 0;
        wallShadowOffset.y = 0;
      }
    };

    requestAnimationFrame(animateShadowReturn);
  });

  return { engine, render, ball, config };
}
