# c10000 qualification, decided BEFORE the campaign (Spike 3)

## Capacity check, recorded before starting

    filesystem            /  on /dev/mapper/ubuntu--vg-ubuntu--lv
    size                  914G
    free before campaign  5.7G
    corpus (c10000)       42M   (.pms-bench/corpora/c10000-t1000-r100-s307)
    estimated per job     ~150M (project copy 42M + output generation ~20M
                                 + staging generation ~20M + retired generation)
    jobs are sequential and each job directory is removed when the job ends,
    so peak occupancy is one job, not the campaign.

5.7G free against a ~150M peak is a ~38x margin. Spike 2 died on this
filesystem at 100% capacity, so the margin is stated rather than assumed.

`PMS_DISCARD_JOB_PROJECT=1` is set: the per-job project copy is dropped as soon
as the job's parse evidence has been recorded.

## Focused scenario set, and why it is this set

    no_change
    one_file_existing_atoms
    one_file_new_atom
    five_files_batch
    module_remove
    file_rename
    import_change
    token_value

These are the brief's primary Phase C cases minus the ones that cannot produce
a different publication shape at c10000 (`forbidden_value` and its repair do not
publish, and `module_add` is `module_remove` in the other direction). Each one
exercises a different relationship between the changed set and the published
generation: no change at all, a recompiled file whose atoms already exist, a
recompiled file adding an atom, a batch, a removal, a rename, a dependency
change, and a global fallback.

8 scenarios x 2 engines x 2 warm cache states x 2 iterations = 64 jobs.
