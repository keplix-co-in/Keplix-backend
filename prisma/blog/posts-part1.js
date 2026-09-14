/**
 * Blog posts, part 1 of 4.
 *
 * Split across files purely for reviewability -- a single 20,000-word array is
 * not something anyone can sensibly read a diff of. `index.js` concatenates
 * them back into one array in publication order.
 *
 * Every post carries an explicit `slug`. That is the stable identity the seed
 * matches on, so re-running updates the existing row and never creates a second
 * one -- and titles stay freely editable. Do NOT change a slug once it is live:
 * it is the indexed URL, and changing it orphans the old post rather than
 * renaming it.
 *
 * Allowed tags are limited by util/sanitizeHtml.js: p, h2, h3, ul, ol, li,
 * blockquote, strong, em, a, and a few others. No tables.
 */

export default [
  {
    title: "When Should You Change Your Engine Oil?",
    slug: "when-should-you-change-your-engine-oil",
    category: "Maintenance",
    excerpt:
      "The sticker on your windscreen is a starting point, not an answer. How to judge oil intervals by how you actually drive.",
    content: `
      <p>Engine oil is the cheapest thing standing between your engine and a repair bill in the lakhs. Most owners get the interval wrong in one of two directions: changing it far more often than necessary because a service centre said so, or forgetting entirely until something starts to rattle.</p>

      <h2>The short answer, and why it is only a starting point</h2>
      <p>For most petrol cars in India, the sensible default is <strong>every 10,000 km or 12 months, whichever comes first</strong>. Diesel engines work harder, run hotter and contaminate their oil faster, so aim closer to <strong>7,000 to 8,000 km</strong>.</p>
      <p>That is a default, not a rule, and the reason is that oil does not wear out by distance. It degrades through heat cycles, contamination and time. Two cars with identical odometers can have oil in wildly different condition depending on what those kilometres consisted of.</p>

      <h2>The conditions that shorten the interval</h2>
      <p>Manufacturers describe a set of circumstances as severe service, and most Indian city driving qualifies for several of them at once. Shorten your interval if your driving looks like this:</p>
      <ul>
        <li>Stop-start city traffic, where the engine spends long periods idling hot with little airflow through the radiator</li>
        <li>Frequent short trips under about eight kilometres, where the engine never reaches full operating temperature</li>
        <li>Dusty or unsealed roads, which load the air filter and eventually the oil</li>
        <li>Regularly carrying heavy loads, or towing</li>
        <li>Sustained high ambient temperatures, which describes most of the country for much of the year</li>
      </ul>
      <p>The short-trip case is the one people underestimate. An engine that never fully warms up cannot boil off the water vapour and unburnt fuel that condense in the crankcase. Those dilute the oil and form acids. A car doing 4,000 km a year in five-minute school runs is harder on its oil than one doing 15,000 km of highway.</p>

      <h2>How to check it yourself in two minutes</h2>
      <p>Park on level ground and let the engine cool for at least fifteen minutes so the oil drains back into the sump. Pull the dipstick, wipe it clean, reinsert it fully, then pull it again and read it.</p>
      <p>You are looking at two things. The level should sit between the two marks; if it is at or below the lower one, top up before driving further. Then look at the oil itself. Fresh oil is translucent amber. Used oil darkens gradually, which is normal and expected, because part of its job is to hold combustion soot in suspension. What is not normal is oil that feels gritty between finger and thumb, or that has gone opaque and thick like old coffee.</p>
      <blockquote>If the oil looks milky, foamy or the colour of a milkshake, stop and get it looked at. That usually means coolant is entering the oil, which points at a head gasket. It is a much bigger problem than a service, and continuing to drive makes it worse.</blockquote>

      <h2>Grades, and why the manual is not a suggestion</h2>
      <p>The code on the bottle, something like 5W-30 or 0W-20, describes viscosity. The number before the W is how the oil behaves when cold, and lower is thinner and flows faster at start-up. The number after is viscosity at operating temperature.</p>
      <p>This is not a preference and it is not somewhere to economise. Modern engines have tight tolerances and oil-fed components such as variable valve timing actuators that are engineered around a specific viscosity. Using a thicker oil than specified can starve those parts at cold start, which is precisely when most engine wear happens.</p>
      <p>Your manual states the grade. If you have lost it, the figure is often printed on the oil filler cap. Use that, and treat any workshop that shrugs at the question as having told you something useful about itself.</p>

      <h2>Mineral, semi-synthetic and fully synthetic</h2>
      <p>Mineral oil is refined crude, and it is now rare outside older or very basic engines. Semi-synthetic blends mineral base with synthetic components and covers most mainstream cars. Fully synthetic is engineered from the ground up, holds its viscosity across a far wider temperature range, and resists breaking down under heat.</p>
      <p>The practical guidance is simple. If your manual specifies fully synthetic, it is not optional, and using anything else risks both the engine and your warranty. If your car calls for semi-synthetic, upgrading to fully synthetic buys slightly better cold-start protection and a longer safe interval, but rarely enough to justify the cost on a low-mileage city car. Follow the manual rather than the counter staff.</p>

      <h2>Do not skip the filter</h2>
      <p>Changing oil while keeping the old filter is a false economy that workshops occasionally offer to make a quote look competitive. The filter holds a meaningful volume of dirty oil and all the debris it has caught, and that contaminates the fresh oil the moment the engine turns over.</p>
      <p>The filter is a few hundred rupees. Any competent workshop replaces both as a matter of course, and a quote that separates them so the headline number looks lower is a quote worth reading more carefully.</p>

      <h2>What actually happens if you leave it too long</h2>
      <p>Nothing dramatic, briefly, which is exactly why it is easy to keep postponing. Oil that has degraded loses its ability to carry heat away and to hold contaminants in suspension. Deposits begin forming in the narrow oil galleries that feed the top of the engine. On engines with hydraulic valve lifters or variable valve timing, those passages are small enough that sludge measurably restricts flow.</p>
      <p>The symptoms arrive slowly: slightly worse fuel consumption, a rougher idle, a top end that ticks on cold mornings. By the time anything is obviously wrong, the wear has already happened and is not reversible. That is the real argument for keeping to an interval. Not that skipping one service destroys an engine, but that the damage from repeatedly stretching them is invisible until it is expensive.</p>

      <h2>A reasonable routine</h2>
      <p>Check the level once a month and before any long drive. Change the oil and filter at the manufacturer interval, or sooner if most of your driving falls into the severe list above. Keep the invoices, because a documented service history is worth real money at resale and is the first thing a careful buyer asks for.</p>
    `,
  },

  {
    title: "How to Choose a Garage You Can Actually Trust",
    slug: "how-to-choose-a-garage-you-can-actually-trust",
    category: "Guides",
    excerpt:
      "Most people pick a workshop by proximity and hope. Here are the checks that actually predict whether you will be treated fairly.",
    content: `
      <p>Choosing a workshop is one of those decisions people make badly because the feedback loop is so slow. You find out whether the garage was honest months later, if at all, and by then you have usually forgotten what you were told. The result is that most people choose by proximity and stay by inertia.</p>
      <p>There are better signals available, and none of them require knowing anything about cars.</p>

      <h2>Ask for a written estimate before any work starts</h2>
      <p>This single habit prevents most disputes. A written estimate, with parts and labour listed separately, converts a vague conversation into something you can hold someone to. It also tells you a great deal about the workshop before they touch the car.</p>
      <p>A good one will happily produce one. A workshop that resists, or insists it cannot know until they open things up, is sometimes being honest about a genuinely uncertain diagnosis. But even then, they can quote for the diagnosis itself and call you with a number before proceeding. Refusing to commit to anything in writing is a choice, not a constraint.</p>

      <h2>Insist on being called before extra work</h2>
      <p>Say it out loud when you hand over the keys: nothing beyond the estimate without a phone call first. This is the most valuable sentence in the entire relationship, because it converts a surprise at collection into a decision you made with the number in front of you.</p>
      <p>Workshops that do this as standard practice are the ones worth keeping. The failure mode you are protecting against is not usually fraud. It is a technician who genuinely believes the extra work is needed and does not think to ask, and you discovering at the counter that a quoted service of three thousand has become nine.</p>

      <h2>Ask for the old parts back</h2>
      <p>It is a completely normal request, it costs the workshop nothing, and it is the cleanest available proof that a part was actually replaced. You do not need to inspect them expertly. Simply asking changes the incentives, and a workshop that reacts badly to a routine request has told you something.</p>
      <p>The exceptions are legitimate: some components carry a core charge and go back to the supplier for remanufacturing, batteries are exchanged for scrap value, and oil obviously cannot be handed over. Those are reasonable answers. Vagueness is not.</p>

      <h2>Judge how they explain things</h2>
      <p>This is more predictive than any credential. Ask why a part needs replacing and listen to the shape of the answer. Someone who knows what they are doing can explain it in plain language, describe what happens if you leave it, and tell you honestly whether it is urgent or something to watch.</p>
      <p>Be wary of two patterns. The first is everything being simultaneously critical, where every item discovered is presented as dangerous to drive on. Cars rarely fail on that many fronts at once, and manufactured urgency is the oldest technique there is. The second is an answer that hides behind jargon. Genuine expertise usually simplifies; padding usually complicates.</p>

      <h2>Look at what they measure</h2>
      <p>A workshop that hands back your car with numbers has done a real inspection. Brake pad thickness in millimetres. Tyre tread depth. Battery voltage. Fluid levels. A workshop that hands back only a bill has told you nothing about what it found, and you have no baseline for next time.</p>
      <p>Those numbers matter beyond the current visit. If you know your pads were at 6mm in March, then a quote in September claiming they are dangerously worn is checkable rather than something you have to take on faith.</p>

      <h2>Understand what you are paying for</h2>
      <p>Authorised dealerships carry higher overheads, use genuine parts by default, and are the safest option while the car is under warranty. A competent independent workshop typically comes in thirty to fifty percent lower on identical work with equivalent parts, and often gives you direct access to the person actually doing the job.</p>
      <p>Neither is automatically right. What matters is knowing which you have chosen and why. Paying dealership rates at an independent, or expecting dealership-level record-keeping from a two-bay garage, is a mismatch of expectations rather than a scam.</p>

      <h2>Check what happens when something goes wrong</h2>
      <p>Ask what warranty they give on their own work, not just on the parts. Parts carry a manufacturer warranty regardless of who fits them. Labour is the workshop's own risk, and a shop confident in its work will typically stand behind it for some months.</p>
      <p>Ask this before you need it. The answer costs you nothing to obtain and tells you how the relationship will go if a repair does not hold.</p>

      <h2>Start small</h2>
      <p>The best way to evaluate a workshop is to give it something inexpensive and low-stakes first. An oil change, a wheel alignment, a battery replacement. You learn how they communicate, whether the estimate matched the invoice, whether they called before doing anything extra, and whether the car came back clean.</p>
      <p>That is a cheap experiment, and it is far better than discovering the answers during a repair that matters. A workshop that handles a small job carefully will usually handle a large one the same way.</p>

      <h2>The signals worth ignoring</h2>
      <p>A busy workshop is not necessarily a good one, and an empty one is not necessarily bad. Premises tell you about capital, not competence. Certificates on the wall are worth something but are easy to overstate. And online ratings for local trades are thin enough that a handful of reviews can move them substantially.</p>
      <p>What holds up over time is boringly consistent: they quote in writing, they call before extra work, they explain in plain language, they give you numbers, and the invoice matches the estimate. Find one that does all five and stay with them.</p>
    `,
  },

  {
    title: "Monsoon Car Care: What Actually Matters",
    slug: "monsoon-car-care-what-actually-matters",
    category: "Seasonal",
    excerpt:
      "Wipers, tyres, brakes and drainage. The short list that prevents most monsoon breakdowns, and what to do if you meet standing water.",
    content: `
      <p>The monsoon is harder on cars than the heat is, and the failures it causes are mostly preventable with an afternoon of attention. The problem is that the components involved are the ones nobody thinks about until the moment they are needed.</p>

      <h2>Tyres come first</h2>
      <p>Everything about wet-weather safety runs through the tyres, and tread depth is the variable that matters most. Tread does not provide grip; the rubber does. What tread does is give water somewhere to go so the rubber can reach the road. As depth reduces, the volume of water the tyre can clear per second falls sharply.</p>
      <p>The legal minimum in India is 1.6mm, marked by moulded wear bars in the main grooves. But wet braking distances degrade well before that. Somewhere around 3mm is where a sensible person replaces tyres if the monsoon is coming. The difference in stopping distance from 80 km/h on a wet road between a 3mm tyre and a 1.6mm one is measured in car lengths.</p>
      <p>Check pressures too, and check them cold. Underinflation makes the tyre flex and the centre of the tread lift slightly, which reduces the contact patch exactly where you need it. The correct figure is on a sticker in the driver door frame, not on the tyre sidewall.</p>

      <h2>Wipers and glass</h2>
      <p>Wiper blades are consumables with roughly a one-year life in Indian conditions, because UV and heat harden the rubber. A blade that smears, chatters or leaves an unwiped band is finished, and replacing a pair is among the cheapest safety improvements available.</p>
      <p>Clean the glass properly before you judge them. Much of what looks like wiper failure is actually a film of road grime and oily residue on the windscreen, which no blade will clear. Glass cleaned with a proper glass cleaner, inside and out, transforms night visibility in rain.</p>
      <p>Top up the washer bottle with actual washer fluid rather than plain water. Water alone will not shift the oily film that traffic throws onto the screen, and in the monsoon you will get through more of it than you expect.</p>

      <h2>Brakes behave differently when wet</h2>
      <p>Wet discs give reduced friction for the first application, which is why a light touch on the brakes after driving through water is a useful habit: it wipes the film off and dries the surface. This matters more than people assume on the approach to the first junction after a flooded stretch.</p>
      <p>If your brake fluid has not been changed in more than two years, do it before the season. Brake fluid absorbs moisture from the air over time, and water in the fluid lowers its boiling point, which is the mechanism behind a pedal that sinks to the floor under sustained heavy braking. It is a cheap job that almost everybody skips.</p>

      <h2>Check the drains</h2>
      <p>Cars have drainage channels most owners never see: at the base of the windscreen under the plastic scuttle panel, in the sunroof rails if fitted, and in the door bottoms. They block with leaves and grit, and when they do, water backs up and finds its way into the cabin.</p>
      <p>A damp footwell is not merely unpleasant. Modern cars route wiring looms and control modules under the carpet and beneath seats, and water there causes electrical faults that are expensive and maddening to trace. Clearing a drain is a five-minute job with a length of garden wire; finding an intermittent electrical fault caused by one is not.</p>
      <p>Sunroof drains deserve special mention because a blocked one typically appears as water dripping from the headliner or the A-pillar, which people misdiagnose as a leaking seal.</p>

      <h2>Electrics and lights</h2>
      <p>Damp finds weak connections. Check that all exterior lights work, including both brake lights and the reversing lights, because visibility in heavy rain depends on being seen at least as much as on seeing. Condensation inside a headlamp housing means the seal has failed and moisture is getting in, which shortens bulb life and eventually corrodes the reflector.</p>
      <p>If your car has an accessory fitted by someone other than the manufacturer, damp weather is when a poor installation announces itself. Spliced joints wrapped in tape corrode, and the resulting faults appear in places that seem unrelated.</p>

      <h2>Standing water: the one rule that matters</h2>
      <p>Do not drive into water when you cannot see the road surface through it or judge its depth. That is the whole rule, and almost every seriously damaged car in a flooded underpass belonged to someone who thought it looked shallow enough.</p>
      <p>The specific danger is hydrolock. Engines compress air, and air is compressible. Water is not. If water is drawn into the air intake and reaches a cylinder, the piston attempts to compress an incompressible fluid on the way up, and something has to give. Usually that means a bent connecting rod, and that means an engine rebuild.</p>
      <blockquote>If your engine stops while in water, do not attempt to restart it. Restarting is what converts water in a cylinder into a destroyed engine. Have the car towed, and tell the workshop it was in flood water so they check before cranking it.</blockquote>
      <p>If you must cross shallow water, go slowly and steadily in a low gear without changing gear, keeping light pressure on the accelerator to maintain exhaust pressure. Then dry the brakes afterwards as described above.</p>

      <h2>After the season</h2>
      <p>Wash the underbody once the rains ease. Road water carries grit and salts that sit in the seams and wheel arches and accelerate corrosion, and the underside is the one part of a car that never gets cleaned incidentally.</p>
      <p>Check the cabin filter as well. Damp plus organic debris is how evaporators start to smell, and a filter that has spent three months wet is usually ready to be replaced.</p>
    `,
  },

  {
    title: "EV Maintenance: What Changes and What Doesn't",
    slug: "ev-maintenance-what-changes-and-what-doesn-t",
    category: "EV",
    excerpt:
      "Electric cars remove a lot of routine servicing but not all of it. What still needs attention, and the parts that wear differently.",
    content: `
      <p>The maintenance case for electric cars is real but frequently overstated. An EV genuinely removes a long list of routine items, because the entire combustion and exhaust apparatus simply is not there. What it does not do is remove maintenance altogether, and a few components actually work harder than they would in a petrol car.</p>

      <h2>What disappears</h2>
      <p>There is no engine oil, so no oil changes and no oil filter. No fuel filter, no air filter for combustion, no spark plugs, no timing belt or chain, no exhaust system, no catalytic converter, no radiator servicing in the conventional sense, and no clutch on a single-speed drivetrain.</p>
      <p>Taken together that is most of what a routine petrol service consists of, and it is why EV servicing intervals are longer and the bills smaller. The saving is genuine and it compounds over the years you own the car.</p>

      <h2>What stays exactly the same</h2>
      <p>Tyres, brakes, suspension, steering, wipers, cabin filter, washer fluid, lights, the twelve-volt battery, and the air conditioning system all behave much as they do in any other car. These are also, collectively, most of what actually goes wrong with cars in daily use.</p>
      <p>The twelve-volt battery is worth calling out because it surprises people. Almost every EV still has one, and it runs the computers, the lights and the contactors that connect the main traction battery. When it fails, the car will not start, and it fails on roughly the same three-to-five-year schedule as in any other vehicle. An EV owner is not exempt from a flat battery on a cold morning.</p>

      <h2>Tyres wear faster, and this is not a defect</h2>
      <p>Electric cars are heavy, because batteries are heavy, and they deliver maximum torque instantly from a standstill. Both of those load the tyres harder than an equivalent petrol car does. Expect meaningfully shorter tyre life, and budget for it.</p>
      <p>Many EVs are also fitted with tyres specified for the car rather than merely for the size, often with reinforced sidewalls to carry the weight and a construction chosen to reduce rolling resistance and noise. Replacing them with the cheapest equivalent size undoes some of that, usually showing up as reduced range and more road noise. Rotating regularly and keeping pressures correct matters more here than on a light hatchback.</p>

      <h2>Brakes wear slower, which brings its own problem</h2>
      <p>Regenerative braking uses the motor to slow the car and recover energy, which means the friction brakes do far less work. Pads and discs on an EV routinely last two or three times as long as they would otherwise.</p>
      <p>The complication is that brakes that are rarely used seize. Discs corrode, calipers stick, and slider pins dry out. It is entirely possible for an EV to need brake work not because the pads are worn but because the hardware has not moved enough. An occasional firm stop from moderate speed helps clean the discs, and an annual inspection that includes freeing off and greasing the caliper slides is worth insisting on.</p>

      <h2>The traction battery, and how to be kind to it</h2>
      <p>The main battery is not serviceable in the way other components are, but how you use it measurably affects how long it lasts. Two factors dominate: heat and time spent at extreme states of charge.</p>
      <ul>
        <li>For daily use, charging to around 80 percent and not routinely running below 20 percent reduces stress on the cells. Most cars let you set a charge limit; use it, and charge to 100 percent only before a long trip.</li>
        <li>DC fast charging is convenient and occasionally necessary, but it generates heat. Habitual fast charging when a slower AC charge would do accelerates degradation.</li>
        <li>Avoid leaving the car sitting at very high or very low charge for long periods, particularly in heat. Around half charge is the kindest place to leave a car parked for weeks.</li>
        <li>Park in shade where you can. Sustained high temperatures are the single biggest environmental factor in cell ageing, which matters in most of India.</li>
      </ul>
      <p>Some capacity loss is normal and expected. Manufacturers warrant the battery against falling below a stated percentage, commonly around seventy percent, within a period usually measured at eight years. Gradual decline within that is degradation, not failure.</p>

      <h2>Coolant is still a thing</h2>
      <p>Most EVs use liquid cooling for the battery pack, the motor and the power electronics, because keeping cells within a temperature window is central to both performance and longevity. That is a real coolant circuit with a real service interval, and it is easy to overlook precisely because there is no engine to associate it with.</p>
      <p>Check what your manufacturer specifies. It is typically a long interval, but long is not the same as never.</p>

      <h2>Charging equipment deserves attention</h2>
      <p>The cable and the home charge point are part of the car's maintenance picture even though they are not part of the car. Inspect the cable for damage and the connector pins for discolouration, which indicates heat and a poor connection. Keep the connector clean and dry.</p>
      <p>If you have a wall box, it should have been installed on a dedicated circuit by a qualified electrician, and it is worth having the installation checked periodically. Charging draws high current for many hours at a time, which is a duty cycle domestic wiring is not always specified for.</p>

      <h2>Finding someone who can work on it</h2>
      <p>High-voltage systems require specific training and equipment, and this is not an area for improvisation. Anything involving the traction battery, the inverter or the orange cabling belongs with a trained technician.</p>
      <p>The everyday items, though, are ordinary car work. Tyres, brakes, suspension, wipers and air conditioning can be handled by any competent workshop, which matters because it means EV ownership does not tie you exclusively to a dealer network for routine jobs.</p>
    `,
  },
];
