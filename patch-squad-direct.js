// Patch: Replace squad per-tick movement with direct positioning approach
// This makes all squad units move together via center+offset interpolation
// instead of individual pathfinding targets
const fs = require('fs');
let code = fs.readFileSync('server.js', 'utf8');
let changeCount = 0;

function replaceOnce(label, oldStr, newStr) {
  const count = code.split(oldStr).length - 1;
  if (count !== 1) {
    console.log(`ERROR [${label}]: expected 1 occurrence, found ${count}`);
    // Try to show context
    if (count === 0) {
      console.log('  String not found in file');
    }
    return false;
  }
  code = code.replace(oldStr, newStr);
  console.log(`OK [${label}]: replaced`);
  changeCount++;
  return true;
}

// ============================================================
// 1. Replace per-tick squad loop with direct positioning
// ============================================================
const oldPerTick = `  // Per-tick squad management: track individual unit navigation without overriding low-level movement
  gameState.squads.forEach((squad, squadId) => {
    if (!squad) return;
    const units = getSquadAliveUnits(squad);
    if (units.length < 2) return;

    const slowestSpeed = getSquadSlowestSpeed(squad);
    units.forEach(u => { u.speed = slowestSpeed; });

    // Initialize squad state if missing
    const actualCenter = getSquadActualCenter(units);
    if (!Number.isFinite(squad.centerX) || !Number.isFinite(squad.centerY)) {
      squad.centerX = actualCenter.x;
      squad.centerY = actualCenter.y;
    }
    if (!Number.isFinite(squad.moveAngle)) {
      const avgForwardX = units.reduce((sum, unit) => sum + Math.cos(unit.angle || 0), 0);
      const avgForwardY = units.reduce((sum, unit) => sum + Math.sin(unit.angle || 0), 0);
      squad.moveAngle = Math.atan2(avgForwardY, avgForwardX);
    }
    if (!Number.isFinite(squad.targetAngle)) {
      squad.targetAngle = squad.moveAngle;
    }

    // Keep actual unit centroid separately from the virtual formation anchor.
    squad.actualCenterX = actualCenter.x;
    squad.actualCenterY = actualCenter.y;

    // Clear formingUp for units that completed navigation or got stuck (no target)
    units.forEach(u => {
      if (u.formingUp && u.targetX === null && u.targetY === null && !u.pathWaypoints) {
        u.formingUp = false;
        u.formingUpUntil = null;
      }
    });

    // Determine if anchor has reached its final destination
    const anchorHasTarget = Number.isFinite(squad.targetX) && Number.isFinite(squad.targetY);
    const anchorAtDestination = anchorHasTarget
      ? Math.hypot(squad.targetX - squad.centerX, squad.targetY - squad.centerY) < 15
      : true;

    // Movement is now entirely handled by the existing unit movement/pathfinding layer.
    const anchorChanged = advanceSquadAnchorTowardTarget(squad, deltaTime);
    // While anchor is moving, bypass cooldown to keep units retargeted frequently.
    // But use shouldRefreshSquadUnitTarget to avoid unnecessary re-pathing.
    const anchorMoving = !anchorAtDestination;
    if (anchorMoving) {
      squad.lastFormationRetargetAt = 0; // bypass cooldown
    }
    refreshSquadFormationMovementTargets(squad, units, now, false);

    // Squad stops moving only when anchor arrived AND all units finished navigating
    if (anchorAtDestination) {
      const stillNavigating = units.some(u => (
        u.formingUp ||
        u.targetX !== null ||
        u.targetY !== null ||
        (u.pathWaypoints && u.pathWaypoints.length > 0)
      ));
      squad.moving = stillNavigating;
      if (!stillNavigating) {
        squad.centerWaypoints = null;
        squad.moveAngle = squad.targetAngle;
        if (anchorHasTarget) {
          squad.centerX = squad.targetX;
          squad.centerY = squad.targetY;
        }
      }
    } else {
      squad.moving = true;
    }
  });`;

const newPerTick = `  // Per-tick squad formation: direct position interpolation (center + offset)
  gameState.squads.forEach((squad, squadId) => {
    if (!squad) return;
    const units = getSquadAliveUnits(squad);
    if (units.length < 2) return;

    const slowestSpeed = getSquadSlowestSpeed(squad);
    units.forEach(u => { u.speed = slowestSpeed; });

    // Initialize centerX/Y if missing
    if (!Number.isFinite(squad.centerX) || !Number.isFinite(squad.centerY)) {
      squad.centerX = units.reduce((s, u) => s + u.x, 0) / units.length;
      squad.centerY = units.reduce((s, u) => s + u.y, 0) / units.length;
    }

    // Move virtual center along waypoints or straight to target
    if (squad.moving && Number.isFinite(squad.targetX) && Number.isFinite(squad.targetY)) {
      const centerStep = slowestSpeed * deltaTime * 60;

      // Follow waypoints if available
      if (squad.centerWaypoints && squad.centerWaypoints.length > 0) {
        const wp = squad.centerWaypoints[0];
        const wdx = wp.x - squad.centerX;
        const wdy = wp.y - squad.centerY;
        const wDist = Math.hypot(wdx, wdy);
        // Update moveAngle to face current waypoint direction
        if (wDist > 1) squad.moveAngle = Math.atan2(wdy, wdx);
        if (wDist < centerStep + 5) {
          squad.centerX = wp.x;
          squad.centerY = wp.y;
          squad.centerWaypoints.shift();
          if (squad.centerWaypoints.length === 0) squad.centerWaypoints = null;
        } else {
          squad.centerX += (wdx / wDist) * centerStep;
          squad.centerY += (wdy / wDist) * centerStep;
        }
      } else {
        // Move straight to target
        const tdx = squad.targetX - squad.centerX;
        const tdy = squad.targetY - squad.centerY;
        const tDist = Math.hypot(tdx, tdy);
        if (tDist < 10) {
          squad.centerX = squad.targetX;
          squad.centerY = squad.targetY;
          squad.moving = false;
        } else {
          const step = Math.min(tDist, centerStep);
          squad.centerX += (tdx / tDist) * step;
          squad.centerY += (tdy / tDist) * step;
        }
      }

      // Check final arrival
      const finalDx = squad.targetX - squad.centerX;
      const finalDy = squad.targetY - squad.centerY;
      if (Math.hypot(finalDx, finalDy) < 10) {
        squad.centerX = squad.targetX;
        squad.centerY = squad.targetY;
        squad.moving = false;
        squad.centerWaypoints = null;
      }
    }

    // Smooth-move each unit toward center + rotated offset (no individual pathfinding)
    const cx = squad.centerX;
    const cy = squad.centerY;
    const catchUpSpeed = slowestSpeed * deltaTime * 60 * 2.5;
    const moveAngle = Number.isFinite(squad.moveAngle) ? squad.moveAngle : 0;

    units.forEach(u => {
      // Calculate desired position from forward/lateral offsets rotated by current moveAngle
      const fwd = Number.isFinite(u.squadForwardOffset) ? u.squadForwardOffset : 0;
      const lat = Number.isFinite(u.squadLateralOffset) ? u.squadLateralOffset : 0;
      const rotated = rotateSquadLocalOffset(fwd, lat, moveAngle);
      const desiredX = cx + rotated.x;
      const desiredY = cy + rotated.y;

      const dx = desiredX - u.x;
      const dy = desiredY - u.y;
      const dist = Math.hypot(dx, dy);

      if (dist < 1) {
        u.x = desiredX;
        u.y = desiredY;
      } else {
        const step = Math.min(dist, catchUpSpeed);
        const nx = u.x + (dx / dist) * step;
        const ny = u.y + (dy / dist) * step;

        // Terrain handling with sliding
        if (u.type === 'worker' || isAirUnitType(u)) {
          const clamped = clampToMapBounds(nx, ny);
          u.x = clamped.x;
          u.y = clamped.y;
        } else if (isLandCombatUnitType(u)) {
          const clampedNext = clampToMapBounds(nx, ny);
          if (isOnLand(clampedNext.x, clampedNext.y)) {
            u.x = clampedNext.x;
            u.y = clampedNext.y;
          } else {
            const slideX = clampToMapBounds(nx, u.y);
            const slideY = clampToMapBounds(u.x, ny);
            const canSlideX = isOnLand(slideX.x, slideX.y);
            const canSlideY = isOnLand(slideY.x, slideY.y);
            if (canSlideX && canSlideY) {
              if (Math.abs(dx) >= Math.abs(dy)) { u.x = slideX.x; u.y = slideX.y; }
              else { u.x = slideY.x; u.y = slideY.y; }
            } else if (canSlideX) { u.x = slideX.x; u.y = slideX.y; }
            else if (canSlideY) { u.x = slideY.x; u.y = slideY.y; }
          }
        } else {
          // Naval: terrain sliding
          const clampedNext = clampToMapBounds(nx, ny);
          if (isNavalPositionTerrainPassable(u, clampedNext.x, clampedNext.y)) {
            u.x = clampedNext.x;
            u.y = clampedNext.y;
          } else {
            const slideX = clampToMapBounds(nx, u.y);
            const slideY = clampToMapBounds(u.x, ny);
            const canSlideX = isNavalPositionTerrainPassable(u, slideX.x, slideX.y);
            const canSlideY = isNavalPositionTerrainPassable(u, slideY.x, slideY.y);
            if (canSlideX && canSlideY) {
              if (Math.abs(dx) >= Math.abs(dy)) { u.x = slideX.x; u.y = slideX.y; }
              else { u.x = slideY.x; u.y = slideY.y; }
            } else if (canSlideX) { u.x = slideX.x; u.y = slideX.y; }
            else if (canSlideY) { u.x = slideY.x; u.y = slideY.y; }
          }
        }
      }

      // Squad controls positioning; clear individual movement
      u.targetX = null;
      u.targetY = null;
      u.pathWaypoints = null;
      u.angle = moveAngle;
      u.collisionWakeUntil = null;
      u.formingUp = false;
      u.formingUpUntil = null;

      if (squad.attackMove) {
        u.attackMove = true;
      }
    });

    // Post-formation collision separation: push overlapping squad-mates apart when stopped
    if (!squad.moving) {
      for (let i = 0; i < units.length; i++) {
        const ui = units[i];
        for (let j = i + 1; j < units.length; j++) {
          const uj = units[j];
          if (doSelectionEllipsesOverlapWithPadding(ui, ui.x, ui.y, uj, uj.x, uj.y, NAVAL_COLLISION_CLEARANCE_BUFFER)) {
            const sdx = uj.x - ui.x;
            const sdy = uj.y - ui.y;
            const sDist = Math.hypot(sdx, sdy);
            if (sDist < 0.1) continue;
            const pushStr = 1.5 * deltaTime * 60;
            const pnx = sdx / sDist;
            const pny = sdy / sDist;
            ui.x -= pnx * pushStr;
            ui.y -= pny * pushStr;
            uj.x += pnx * pushStr;
            uj.y += pny * pushStr;
          }
        }
      }
    }
  });`;

replaceOnce('per-tick squad loop', oldPerTick, newPerTick);

// ============================================================
// 2. Fix issueSquadMoveOrder: don't use individual pathfinding
// ============================================================
const oldMoveOrder = `  const formingUpUntil = Date.now() + 60000;
  positions.forEach(({ unit }) => {
    unit.speed = slowestSpeed;
    unit.holdPosition = false;
    unit.attackMove = false;
    unit.attackTargetId = null;
    unit.attackTargetType = null;
    unit.squadDesiredAngle = targetAngle;
    unit.squadDesiredAngleUpdatedAt = Date.now();
    unit.formingUp = true;
    unit.formingUpUntil = formingUpUntil;
    resetNavalAvoidanceState(unit);
  });
  refreshSquadFormationMovementTargets(squad, units, Date.now(), true);
}

function issueSquadAttackTarget`;

const newMoveOrder = `  positions.forEach(({ unit }) => {
    unit.speed = slowestSpeed;
    unit.holdPosition = false;
    unit.attackMove = false;
    unit.attackTargetId = null;
    unit.attackTargetType = null;
    unit.angle = targetAngle;
    unit.formingUp = false;
    unit.formingUpUntil = null;
    unit.targetX = null;
    unit.targetY = null;
    unit.pathWaypoints = null;
    resetNavalAvoidanceState(unit);
  });
}

function issueSquadAttackTarget`;

replaceOnce('issueSquadMoveOrder', oldMoveOrder, newMoveOrder);

// ============================================================
// 3. Fix issueSquadAttackMove: don't use individual pathfinding
// ============================================================
const oldAttackMove = `  const formingUpUntil = Date.now() + 60000;
  positions.forEach(({ unit }) => {
    unit.speed = slowestSpeed;
    unit.holdPosition = false;
    unit.attackMove = true;
    unit.attackTargetId = null;
    unit.attackTargetType = null;
    unit.squadDesiredAngle = targetAngle;
    unit.squadDesiredAngleUpdatedAt = Date.now();
    unit.formingUp = true;
    unit.formingUpUntil = formingUpUntil;
    resetNavalAvoidanceState(unit);
  });
  refreshSquadFormationMovementTargets(squad, units, Date.now(), true);
}

function issueGroupedMoveOrder`;

const newAttackMove = `  positions.forEach(({ unit }) => {
    unit.speed = slowestSpeed;
    unit.holdPosition = false;
    unit.attackMove = true;
    unit.attackTargetId = null;
    unit.attackTargetType = null;
    unit.angle = targetAngle;
    unit.formingUp = false;
    unit.formingUpUntil = null;
    unit.targetX = null;
    unit.targetY = null;
    unit.pathWaypoints = null;
    resetNavalAvoidanceState(unit);
  });
}

function issueGroupedMoveOrder`;

replaceOnce('issueSquadAttackMove', oldAttackMove, newAttackMove);

// ============================================================
// 4. Add squad skip in individual movement section
// ============================================================
const oldMovementSection = `    // Movement
    if (unit.targetX !== null && unit.targetY !== null) {`;

const newMovementSection = `    // Movement - skip units controlled by squad (positioned directly by squad loop above)
    if (unit.squadId) {
      // Squad units are positioned by the per-tick squad formation loop
      // Do nothing here — skip all individual movement/pathfinding
    } else if (unit.targetX !== null && unit.targetY !== null) {`;

replaceOnce('movement squad skip', oldMovementSection, newMovementSection);

// ============================================================
// 5. Revert the squad facing fix (no longer needed, squad loop sets angle)
// ============================================================
const oldFacing = `        // For squad units, use smooth facing toward squad direction when close
        if (unit.squadId && distance < 40 && Number.isFinite(unit.squadDesiredAngle)) {
          unit.angle = unit.squadDesiredAngle;
        } else {
          unit.angle = Math.atan2(dy, dx);
        }`;

const newFacing = `        unit.angle = Math.atan2(dy, dx);`;

replaceOnce('revert squad facing', oldFacing, newFacing);

// ============================================================
// 6. Fix squad creation handler too (don't use individual pathfinding)
// ============================================================
const oldSquadCreate = `      const fUntil = Date.now() + 3000;
      pos.forEach(({ unit }) => {
        unit.speed = spd;
        unit.squadDesiredAngle = formationAngle;
        unit.squadDesiredAngleUpdatedAt = Date.now();
        unit.formingUp = true;
        unit.formingUpUntil = fUntil;
      });
      sq.lastFormationRetargetAt = 0;
      refreshSquadFormationMovementTargets(sq, sUnits, Date.now(), true);`;

const newSquadCreate = `      pos.forEach(({ unit }) => {
        unit.speed = spd;
        unit.angle = formationAngle;
        unit.formingUp = false;
        unit.formingUpUntil = null;
        unit.targetX = null;
        unit.targetY = null;
        unit.pathWaypoints = null;
      });`;

replaceOnce('squad formation type change', oldSquadCreate, newSquadCreate);

// ============================================================
// Done
// ============================================================
if (changeCount === 6) {
  fs.writeFileSync('server.js', code, 'utf8');
  console.log(`\nAll ${changeCount} patches applied successfully!`);
} else {
  console.log(`\nOnly ${changeCount}/6 patches succeeded. File NOT saved.`);
  process.exit(1);
}
