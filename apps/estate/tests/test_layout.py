"""The estate's arrangement: one row of blocks, and open ground in front.

A block is impassable, so a block between either viewer (they look in from
the south-east) and the courtyard hides it. The recipe's `layout: "row"`
puts every block on the same northern line, doors south, so the courtyard
and the perimeter path stay in front of the row and visible. These pin the
arrangement against generation rather than trusting the comments around it.

Run from `apps/estate`:

    python3 -m unittest discover -s tests
"""

import unittest

from estate import gen, rules


class RowLayoutTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.w = gen.generate(42)
        cls.blocks = [b for b in cls.w["buildings"].values()
                      if b["kind"] == "block"]

    def test_one_row_of_the_recipe_s_blocks(self):
        self.assertEqual(rules.R["gen"].get("layout"), "row")
        self.assertEqual(len(self.blocks), rules.R["gen"]["blocks"])
        self.assertEqual(len({b["y"] for b in self.blocks}), 1,
                         "the blocks do not share one row")

    def test_the_row_is_on_the_north(self):
        # no block stands south of the row, so the courtyard and the open
        # ground are what both views see in front of it
        for b in self.blocks:
            self.assertLess(b["y"] + b["h"], self.w["height"] // 2,
                            f"{b['name']} is not on the northern side")

    def test_doors_face_the_open_ground(self):
        for b in self.blocks:
            door = b["door"]
            self.assertEqual(door[1], b["y"] + b["h"],
                             f"{b['name']}'s door is not on its south face")
            cell = self.w["cells"][door[1]][door[0]]
            self.assertNotEqual(cell["site"], "building")
            self.assertIsNotNone(
                rules.R["sites"][cell["site"]]["walk"],
                f"{b['name']}'s door is not walkable ground")

    def test_the_row_leaves_the_perimeter_benches_their_band(self):
        for f in self.w["fixtures"].values():
            if f["kind"] != "bench" or not f.get("perimeter"):
                continue
            self.assertFalse(
                any(b["x"] <= f["x"] < b["x"] + b["w"]
                    and b["y"] <= f["y"] < b["y"] + b["h"]
                    for b in self.blocks),
                f"perimeter bench at {f['x']},{f['y']} is inside a block")

    def test_the_row_keeps_the_estate_s_capacity(self):
        # fewer, taller blocks: at seed 42 the row is the old plan's ~67
        # flats, not half of them, so occupancy and the gate's population
        # band still describe the same estate
        self.assertGreaterEqual(len(self.w["units"]), 60)
        self.assertLessEqual(len(self.w["units"]), 85)


if __name__ == "__main__":
    unittest.main()
