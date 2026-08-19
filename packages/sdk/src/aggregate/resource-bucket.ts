// The shared per-resource, per-bucket aggregation cell (docs/specs/sdk.md, Module: sdk/aggregate):
// a host writes one hook against one input type instead of one per aggregation surface.
/**
 * The per-resource, per-bucket input a load or capacity hook receives. Type-only: no runtime code
 * ships from this module.
 */

/**
 * The per-resource, per-bucket input handed to a `resourceLoad` or `resourceCapacity` hook.
 *
 * One object of this shape is allocated per build of the surface and **reused** across that
 * build's calls, its fields overwritten before each one. So it is valid only for the duration of
 * the call and must not be retained, stored or read after the hook returns — copy whatever you
 * keep. A hook that re-enters the plugin gets a fresh object for the nested build, so a nested
 * build never rewrites the input of the call that is still running.
 *
 * `R` is the resource object of the calling plugin: an aggregation surface hands its own resource
 * shape — a data-store resource, or a resource-pool entry when one exists for that resource and
 * the data-store resource otherwise.
 *
 * An adjustment expressed per working time — the reason `workingMs` and `workingDays` are here —
 * holds whatever bucket width the surface asks at; a flat per-bucket amount does not, and surfaces
 * that coarsen their buckets will then disagree with those that do not.
 */
export interface ResourceBucketInput<R> {
  /** The resource this cell belongs to. Valid only during the call — do not retain. */
  readonly resource: R;
  /** The resource's id. */
  readonly resourceId: string | number;
  /** The resource's display name. */
  readonly resourceName: string;
  /**
   * The resource's dimensionless capacity rate (its declared capacity, or 1) — the rate the
   * built-in capacity baseline multiplies by the bucket's working time.
   */
  readonly capacityRate: number;
  /** Bucket start, epoch milliseconds UTC, inclusive. */
  readonly bucketStart: number;
  /** Bucket end, epoch milliseconds UTC, exclusive. */
  readonly bucketEnd: number;
  /** The working time for this resource inside the bucket, in milliseconds. */
  readonly workingMs: number;
  /**
   * The count of UTC calendar days inside the bucket that contain any working time for this
   * resource.
   */
  readonly workingDays: number;
  /** The built-in allocated effort for this cell, which a `resourceLoad` hook may adjust. */
  readonly allocated: number;
  /** The built-in available effort for this cell, which a `resourceCapacity` hook may adjust. */
  readonly capacity: number;
}
