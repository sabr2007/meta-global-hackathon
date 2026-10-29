# Why Ayna

**Show your robot the after.** Ayna turns an iPhone LiDAR scan of a room into a physics twin, edits your own photo into the state you asked for, and scores the robot's result against that photo in centimetres.

## The problem

Telling a robot what you want is still hard. "Tidy my desk" means something different on every desk, and a text plan does not say where each object should end up. Trust is the other half: you cannot see what a robot will do to your things before it moves, or easily check the result after. For chores NEO cannot do yet, owners can schedule a [remote 1X Expert to guide it](https://www.1x.tech/neo).

## Why now

- **Home robots are on sale.** [1X takes orders for NEO at $20,000, with US deliveries starting in 2026](https://www.1x.tech/order). Sunday's [Memo beta launches in late 2026](https://www.sunday.ai/).
- **Every home is different.** [π0.5 needed about 100 training environments](https://www.pi.website/blog/pi05) before it approached a model trained in the test environment itself.
- **Measuring a robot is slow.** [Pinning a 90% success rate to ±2 points takes 1,030 rollouts](https://developer.nvidia.com/blog/how-to-evaluate-general-purpose-robot-policies-for-real-world-deployment/), and a real-to-sim scene [can take over an hour to set up](https://developer.nvidia.com/blog/how-to-evaluate-general-purpose-robot-policies-for-real-world-deployment/). Y Combinator now funds startups built around robot evaluation: [Instance](https://www.ycombinator.com/companies/instance), [Robocurve](https://www.ycombinator.com/companies/robocurve), [One Robot](https://www.ycombinator.com/companies/one-robot).

## Where Ayna fits

- **Voice-to-pick demos.** Meta's [cookbook robotics kiosk](https://github.com/meta-models/meta-model-cookbook/tree/main/03_use_cases/14_muse_robotics) turns speech into a plan for a simulated arm in a fixed scene; segmentation is for display only. No scan, no real room, no goal picture.
- **Scan-to-sim tools.** [PolaRiS](https://arxiv.org/html/2512.16881) turns a short video scan into an evaluation scene, but whoever builds it also writes the success criterion. [Parallax Worlds](https://www.therobotreport.com/parallax-worlds-raises-4m-stress-test-robots-hyper-realistic-digital-twins/) builds twins from iPhone video for teams to test their own software. [RoboSimStudio](https://github.com/robosimstudio/robosimstudio) rebuilds a task from a reference video. They build the room; a person supplies the task. In Ayna, the after-photo is the task, and the verifier comes with it.
- **Goal-conditioned planners.** Meta's [V-JEPA 2-AC reaches 65–80% pick-and-place on new objects in unseen environments](https://ai.meta.com/blog/v-jepa-2-world-model-benchmarks/) given a goal image. FAIR's [RoboJEPA, trained on 12 robot embodiments, plans toward a single goal image](https://arxiv.org/abs/2610.10515). Both assume the goal image exists. Ayna makes it from the owner's photo and checks it before a robot uses it.

We found no other system that joins a phone-scanned twin, a goal edited from a photo of that room, and a check against that photo.

## Who it is for

- **People a robot comes home to.** They see the after-photo and a rehearsal in their own twin, then approve or decline before anything moves. The picture is the consent screen.
- **Robotics teams that need real-home evaluation.** Each scan, after-photo and verifier is an evaluation episode in a real home, with an automatic success check instead of hand-written task code.

## What we measure

- **Placement error per object, in centimetres,** between the twin's final state, rendered from the photo's camera, and the after-photo. An object counts as placed within 3 cm, about half the smallest object on the desk; [Meta's Habitat 2.0 allows 15 cm for Tidy House](https://arxiv.org/abs/2106.14405) at room scale. The score is requested moves done times objects left in place, so a refused move always costs points.
- **Conservation.** Objects that vanished or appeared between before and after, found with SAM masks. Any such object rejects the edit, since editors often [get object position and scale wrong](https://arxiv.org/abs/2604.07230).
- **Placement, not looks.** Robot success tracks whether an edit moved the right object to the right state [(Spearman ρ ≈ 0.9); photorealism does not predict it (ρ ≈ 0)](https://arxiv.org/abs/2610.24885).
- **Success rate and refusals,** with a reason for each declined goal. For scale: the best team in the [NeurIPS 2023 HomeRobot challenge reached 10.8% success](https://arxiv.org/abs/2407.06939), and [TidyBot put away 85.0% of objects in real tests](https://arxiv.org/abs/2305.05658).
