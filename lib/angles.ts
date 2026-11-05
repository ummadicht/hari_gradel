import { cameraSpec } from "./deviceSpecs";

// The capture angles GradeIQ guides the operator through, tuned to the phone so
// the AI sees the parts that actually wear/crack (camera bump, edges, ports).
// Model-aware: the camera-bump angle reflects the device's real lens count, and
// multi-lens devices add a dedicated lens close-up so every lens cover is
// inspected for scratches.
export function anglesFor(model: string): string[] {
  const nRear = cameraSpec(model).rear.length;
  const bump = `Back — ${nRear} rear camera${nRear > 1 ? "s" : ""}`;
  const lensCloseup = nRear > 1 ? ["Camera lenses close-up"] : [];

  // Core-first: the 4 essential sides every device needs, then optional extras
  // (the guided flow only requires the core; the AI/staff can add the rest).
  if (/iphone/i.test(model))
    return [
      "Front / screen",
      bump,
      "Left edge",
      "Right edge (buttons)",
      ...lensCloseup,
      "Bottom (charge port)",
      "Screen corners",
    ];
  if (/galaxy|pixel|android|oneplus|xiaomi|redmi/i.test(model))
    return [
      "Front / screen",
      bump,
      "Left edge",
      "Right edge (buttons)",
      ...lensCloseup,
      "Bottom (USB-C)",
      "Corners",
    ];
  return [
    "Front / screen",
    bump,
    "Left edge",
    "Right edge",
    ...lensCloseup,
    "Top edge",
    "Bottom edge",
  ];
}
